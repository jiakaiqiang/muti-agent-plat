import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
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

  @Post('device-codes')
  createDeviceCode(
    @Body() body: CreateLocalRuntimeDeviceCodeRequest,
    @Headers('x-forwarded-proto') forwardedProto?: string,
    @Headers('host') host?: string
  ) {
    const publicUrl = process.env.PUBLIC_WEB_URL?.trim() || `${forwardedProto || 'http'}://${host || 'localhost:3000'}`;
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

  @Post('workspaces/authorize')
  @UseGuards(LocalRuntimeAdminGuard)
  async authorizeWorkspace(@Body() body: { deviceId?: string }) {
    const startedAt = Date.now();
    try {
      return ok(await this.connections.authorizeWorkspace(body.deviceId?.trim() || undefined));
    } finally {
      workspaceMetrics.observe('workspace_authorization_duration_ms', Date.now() - startedAt, {
        providerKind: 'local_bridge'
      });
    }
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
