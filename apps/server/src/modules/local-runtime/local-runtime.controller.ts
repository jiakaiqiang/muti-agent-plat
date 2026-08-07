import { Body, Controller, Delete, Get, Headers, Param, Post, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { CreateLocalRuntimeDeviceCodeRequest, LocalRuntimeProviderConnectionInput } from '@agent-cluster/shared';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';
import { LocalRuntimeAdminGuard } from './local-runtime-admin.guard.js';
import { ok } from '../../common/api-response.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';

@Controller('local-runtime')
export class LocalRuntimeController {
  constructor(
    private readonly auth: LocalRuntimeAuthService,
    private readonly connections: LocalRuntimeConnectionService
  ) {}

  @Get('launch-config')
  launchConfig(
    @Headers('x-forwarded-proto') forwardedProto?: string,
    @Headers('host') host?: string
  ) {
    return ok({ serverUrl: publicServerOrigin(forwardedProto, host) });
  }

  @Post('device-codes')
  createDeviceCode(
    @Body() body: CreateLocalRuntimeDeviceCodeRequest,
    @Headers('x-forwarded-proto') forwardedProto?: string,
    @Headers('host') host?: string
  ) {
    const publicUrl = publicServerOrigin(forwardedProto, host);
    return this.auth.createDeviceCode(body, publicUrl);
  }

  @Post('device-codes/approve')
  @UseGuards(LocalRuntimeAdminGuard)
  approve(@Body() body: { userCode?: string }) {
    return ok(this.auth.approveDeviceCode(body.userCode ?? ''));
  }

  @Post('device-tokens')
  exchange(@Body() body: { deviceCode?: string }) {
    return this.auth.exchangeDeviceCode(body.deviceCode ?? '');
  }

  @Post('device-tokens/loopback')
  @UseGuards(LocalRuntimeAdminGuard)
  authorizeLoopback(@Body() body: CreateLocalRuntimeDeviceCodeRequest) {
    return this.auth.authorizeTrustedDevice(body);
  }

  @Post('device-tokens/refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    return this.auth.refresh(body.refreshToken ?? '');
  }

  @Get('device-tokens/current')
  currentDevice(@Headers('authorization') authorization?: string) {
    const device = this.auth.authenticate(bearerToken(authorization));
    return { ...device, connected: this.connections.isDeviceConnected(device.deviceId) };
  }

  @Delete('device-tokens/current')
  revokeCurrentDevice(@Headers('authorization') authorization?: string) {
    const device = this.auth.authenticate(bearerToken(authorization));
    this.connections.disconnectDevice(device.deviceId, 'device_revoked');
    return this.auth.revokeDevice(device.deviceId, device.ownerId);
  }

  @Get('devices')
  @UseGuards(LocalRuntimeAdminGuard)
  devices() {
    return ok(this.auth.listDevices().map((device) => ({
      ...device,
      connected: this.connections.isDeviceConnected(device.deviceId)
    })));
  }

  @Delete('devices/:deviceId')
  @UseGuards(LocalRuntimeAdminGuard)
  revoke(@Param('deviceId') deviceId: string) {
    this.connections.disconnectDevice(deviceId, 'device_revoked');
    return ok(this.auth.revokeDevice(deviceId));
  }

  @Get('workspaces')
  @UseGuards(LocalRuntimeAdminGuard)
  workspaces() {
    return ok(this.connections.listWorkspaces());
  }

  @Post('capabilities/refresh')
  @UseGuards(LocalRuntimeAdminGuard)
  async refreshCapabilities(@Body() body: { deviceId?: string }) {
    return ok(await this.connections.refreshCapabilities(body.deviceId?.trim() || undefined));
  }

  @Post('workspaces/authorize')
  @UseGuards(LocalRuntimeAdminGuard)
  async authorizeWorkspace(
    @Body() body: { deviceId?: string; requestId?: string },
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    const startedAt = Date.now();
    const requestId = body.requestId?.trim() || randomUUID();
    let settled = false;
    const cancelOnDisconnect = () => {
      if (!settled) this.connections.cancelWorkspaceAuthorization(requestId);
    };
    response.once('close', cancelOnDisconnect);
    try {
      return ok(await this.connections.authorizeWorkspace(
        body.deviceId?.trim() || undefined,
        requestId
      ));
    } finally {
      settled = true;
      response.off('close', cancelOnDisconnect);
      workspaceMetrics.observe('workspace_authorization_duration_ms', Date.now() - startedAt, {
        providerKind: 'local_bridge'
      });
    }
  }

  @Delete('workspaces/authorizations/:requestId')
  @UseGuards(LocalRuntimeAdminGuard)
  cancelWorkspaceAuthorization(@Param('requestId') requestId: string) {
    return ok({
      requestId,
      cancelled: this.connections.cancelWorkspaceAuthorization(requestId)
    });
  }

  @Post('provider-connections')
  @UseGuards(LocalRuntimeAdminGuard)
  async upsertProviderConnection(@Body() body: { deviceId?: string; connection?: LocalRuntimeProviderConnectionInput }) {
    const deviceId = body.deviceId?.trim();
    if (!deviceId || !body.connection) throw new Error('deviceId and provider connection are required.');
    return ok(await this.connections.upsertProviderConnection(deviceId, body.connection));
  }

  @Delete('provider-connections/:deviceId/:connectionId')
  @UseGuards(LocalRuntimeAdminGuard)
  async deleteProviderConnection(@Param('deviceId') deviceId: string, @Param('connectionId') connectionId: string) {
    await this.connections.deleteProviderConnection(deviceId, connectionId);
    return ok({ deleted: true });
  }
}

function bearerToken(value: string | undefined) {
  return value?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? '';
}

function publicServerOrigin(forwardedProto?: string, host?: string) {
  const configured = process.env.PUBLIC_WEB_URL?.trim();
  const candidate = configured || `${forwardedProto || 'http'}://${host || 'localhost:3000'}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new ServiceUnavailableException('PUBLIC_WEB_URL must be a valid HTTP or HTTPS origin.');
  }
}
