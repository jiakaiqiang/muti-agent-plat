import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type {
  CreateLocalRuntimeDeviceCodeRequest,
  LocalRuntimeCompatibility,
  LocalRuntimeDevice,
  LocalRuntimeDeviceCode,
  LocalRuntimeUpgradeInfo,
  LocalRuntimeTokenPendingResponse,
  LocalRuntimeTokenResponse
} from '@agent-cluster/shared';
import { LOCAL_RUNTIME_PROTOCOL_VERSION } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';

type PersistedDevice = LocalRuntimeDevice & {
  accessTokenHash?: string;
  accessTokenExpiresAt?: string;
  refreshTokenHash?: string;
  refreshTokenExpiresAt?: string;
};

type PendingDeviceCode = {
  request: CreateLocalRuntimeDeviceCodeRequest;
  deviceCodeHash: string;
  userCode: string;
  expiresAt: string;
  approvedOwnerId?: string;
};

const DEVICES_COLLECTION = 'localRuntimeDevices';

@Injectable()
export class LocalRuntimeAuthService {
  private readonly devices = new Map<string, PersistedDevice>();
  private readonly pendingByDeviceCodeHash = new Map<string, PendingDeviceCode>();
  private readonly pendingByUserCode = new Map<string, PendingDeviceCode>();

  constructor(private readonly persistence: PersistenceService) {
    for (const device of persistence.getCollection<PersistedDevice[]>(DEVICES_COLLECTION, [])) {
      this.devices.set(device.deviceId, device);
    }
  }

  createDeviceCode(
    request: CreateLocalRuntimeDeviceCodeRequest,
    verificationBaseUrl: string
  ): LocalRuntimeDeviceCode {
    if (!request.deviceId?.trim() || !request.displayName?.trim() || !request.cliVersion?.trim()) {
      throw new BadRequestException('deviceId, displayName and cliVersion are required.');
    }
    this.pruneExpiredCodes();
    const compatibility = this.compatibility(request.cliVersion, request.protocolVersion);
    const deviceCode = token(32);
    const userCode = userCodeValue();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const pending: PendingDeviceCode = {
      request: structuredClone(request),
      deviceCodeHash: hash(deviceCode),
      userCode,
      expiresAt
    };
    this.pendingByDeviceCodeHash.set(pending.deviceCodeHash, pending);
    this.pendingByUserCode.set(userCode, pending);
    return {
      deviceCode,
      userCode,
      verificationUri: `${verificationBaseUrl.replace(/\/$/, '')}/local-runtime/activate`,
      expiresAt,
      intervalSeconds: 3,
      compatibility
    };
  }

  approveDeviceCode(userCode: string, ownerId = 'local-user'): LocalRuntimeDevice {
    this.pruneExpiredCodes();
    const normalized = userCode.trim().toUpperCase();
    const pending = this.pendingByUserCode.get(normalized);
    if (!pending) throw new NotFoundException('Local Runtime device code is invalid or expired.');
    const compatibility = this.compatibility(
      pending.request.cliVersion,
      pending.request.protocolVersion
    );
    if (!compatibility.compatible) {
      throw new BadRequestException(compatibility.reason ?? 'Local Runtime CLI is incompatible.');
    }
    pending.approvedOwnerId = ownerId;
    const now = new Date().toISOString();
    const existing = this.devices.get(pending.request.deviceId);
    const device: PersistedDevice = {
      ...existing,
      deviceId: pending.request.deviceId,
      ownerId,
      displayName: pending.request.displayName,
      status: 'active',
      cliVersion: pending.request.cliVersion,
      protocolVersion: pending.request.protocolVersion,
      runtimes: pending.request.runtimes,
      createdAt: existing?.createdAt ?? now,
      revokedAt: undefined
    };
    this.devices.set(device.deviceId, device);
    this.persist();
    return publicDevice(device);
  }

  exchangeDeviceCode(deviceCode: string): LocalRuntimeTokenResponse | LocalRuntimeTokenPendingResponse {
    this.pruneExpiredCodes();
    const pending = this.pendingByDeviceCodeHash.get(hash(deviceCode));
    if (!pending) throw new UnauthorizedException('Local Runtime device code is invalid or expired.');
    if (!pending.approvedOwnerId) return { status: 'authorization_pending', retryAfterSeconds: 3 };
    const device = this.devices.get(pending.request.deviceId);
    if (!device || device.status !== 'active') throw new UnauthorizedException('Local Runtime device is not active.');
    this.removePending(pending);
    return this.issueTokens(device);
  }

  authorizeTrustedDevice(
    request: CreateLocalRuntimeDeviceCodeRequest,
    ownerId = 'local-user'
  ): LocalRuntimeTokenResponse {
    if (!request.deviceId?.trim() || !request.displayName?.trim() || !request.cliVersion?.trim()) {
      throw new BadRequestException('deviceId, displayName and cliVersion are required.');
    }
    const compatibility = this.compatibility(request.cliVersion, request.protocolVersion);
    if (!compatibility.compatible) {
      throw new BadRequestException(compatibility.reason ?? 'Local Runtime CLI is incompatible.');
    }
    const now = new Date().toISOString();
    const existing = this.devices.get(request.deviceId);
    const device: PersistedDevice = {
      ...existing,
      deviceId: request.deviceId,
      ownerId,
      displayName: request.displayName,
      status: 'active',
      cliVersion: request.cliVersion,
      protocolVersion: request.protocolVersion,
      runtimes: request.runtimes,
      createdAt: existing?.createdAt ?? now,
      revokedAt: undefined
    };
    this.devices.set(device.deviceId, device);
    return this.issueTokens(device);
  }

  resumeTrustedDevice(deviceId: string, ownerId = 'local-user'): LocalRuntimeTokenResponse {
    const device = this.devices.get(deviceId);
    if (!device || device.ownerId !== ownerId || device.status !== 'active') {
      throw new UnauthorizedException('Only an existing active Local Runtime device can be resumed.');
    }
    return this.issueTokens(device);
  }

  refresh(refreshToken: string): LocalRuntimeTokenResponse {
    const tokenHash = hash(refreshToken);
    const device = [...this.devices.values()].find((candidate) => candidate.refreshTokenHash === tokenHash);
    if (!device || device.status !== 'active' || !isFuture(device.refreshTokenExpiresAt)) {
      throw new UnauthorizedException('Local Runtime refresh token is invalid or expired.');
    }
    return this.issueTokens(device);
  }

  authenticate(accessToken: string): LocalRuntimeDevice {
    const tokenHash = hash(accessToken);
    const device = [...this.devices.values()].find((candidate) => candidate.accessTokenHash === tokenHash);
    if (!device || device.status !== 'active' || !isFuture(device.accessTokenExpiresAt)) {
      throw new UnauthorizedException('Local Runtime access token is invalid or expired.');
    }
    return publicDevice(device);
  }

  touch(deviceId: string, hello?: Pick<LocalRuntimeDevice, 'cliVersion' | 'protocolVersion' | 'runtimes'>) {
    const device = this.devices.get(deviceId);
    if (!device || device.status !== 'active') throw new UnauthorizedException('Local Runtime device is not active.');
    if (hello) {
      const compatibility = this.compatibility(hello.cliVersion, hello.protocolVersion);
      if (!compatibility.compatible) throw new UnauthorizedException(compatibility.reason ?? 'Local Runtime CLI is incompatible.');
      device.cliVersion = hello.cliVersion;
      device.protocolVersion = hello.protocolVersion;
      device.runtimes = hello.runtimes;
    }
    device.lastSeenAt = new Date().toISOString();
    this.persist();
    return publicDevice(device);
  }

  listDevices(ownerId = 'local-user'): LocalRuntimeDevice[] {
    return [...this.devices.values()]
      .filter((device) => device.ownerId === ownerId)
      .map(publicDevice)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  revokeDevice(deviceId: string, ownerId = 'local-user'): LocalRuntimeDevice {
    const device = this.devices.get(deviceId);
    if (!device || device.ownerId !== ownerId) throw new NotFoundException(`Local Runtime device not found: ${deviceId}`);
    device.status = 'revoked';
    device.revokedAt = new Date().toISOString();
    delete device.accessTokenHash;
    delete device.accessTokenExpiresAt;
    delete device.refreshTokenHash;
    delete device.refreshTokenExpiresAt;
    this.persist();
    return publicDevice(device);
  }

  compatibility(cliVersion: string, protocolVersion: number): LocalRuntimeCompatibility {
    const minimumCliVersion = process.env.LOCAL_RUNTIME_MIN_CLI_VERSION?.trim() || '0.1.0';
    if (protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
      const upgradeInfo = this.upgradeInfo(cliVersion, protocolVersion);
      return {
        compatible: false,
        cliVersion,
        protocolVersion,
        requiredProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        requiredCliVersion: minimumCliVersion,
        reason: `不支持协议版本 ${protocolVersion}，需要协议版本 ${LOCAL_RUNTIME_PROTOCOL_VERSION}。`,
        upgradeRequired: true,
        upgradeAvailable: this.isUpgradeAvailable(upgradeInfo),
        upgradeInfo
      };
    }
    if (compareVersions(cliVersion, minimumCliVersion) < 0) {
      const upgradeInfo = this.upgradeInfo(cliVersion, protocolVersion);
      return {
        compatible: false,
        cliVersion,
        protocolVersion,
        requiredProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        requiredCliVersion: minimumCliVersion,
        reason: `本机 CLI 版本 ${cliVersion} 过低，需要升级至 ${minimumCliVersion}。`,
        upgradeRequired: true,
        upgradeAvailable: this.isUpgradeAvailable(upgradeInfo),
        upgradeInfo
      };
    }
    return {
      compatible: true,
      cliVersion,
      protocolVersion,
      requiredProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      requiredCliVersion: minimumCliVersion
    };
  }

  serverCompatibility(): LocalRuntimeCompatibility {
    const minimumCliVersion = process.env.LOCAL_RUNTIME_MIN_CLI_VERSION?.trim() || '0.1.0';
    const targetVersion = process.env.LOCAL_RUNTIME_RELEASE_VERSION?.trim() || `protocol-${LOCAL_RUNTIME_PROTOCOL_VERSION}`;
    const releaseUrl = this.releaseUrl();
    return {
      compatible: true,
      cliVersion: targetVersion,
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      requiredProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      requiredCliVersion: minimumCliVersion,
      upgradeAvailable: releaseUrl ? this.isUpgradeAvailable(this.upgradeInfo(targetVersion, LOCAL_RUNTIME_PROTOCOL_VERSION)) : false,
      ...(releaseUrl ? { upgradeInfo: this.upgradeInfo(targetVersion, LOCAL_RUNTIME_PROTOCOL_VERSION) } : {})
    };
  }

  private upgradeInfo(cliVersion: string, protocolVersion: number): LocalRuntimeUpgradeInfo {
    const targetVersion = process.env.LOCAL_RUNTIME_RELEASE_VERSION?.trim() || `protocol-${LOCAL_RUNTIME_PROTOCOL_VERSION}`;
    const releaseUrl = this.releaseUrl();
    const releaseNotes = (process.env.LOCAL_RUNTIME_RELEASE_NOTES?.trim() || [
      `支持 Local Runtime 协议 ${LOCAL_RUNTIME_PROTOCOL_VERSION}`,
      '修复协议不一致时设备被错误显示为在线',
      '升级后自动恢复本地工作区注册'
    ].join('||')).split('||').map((item) => item.trim()).filter(Boolean);
    const buildId = process.env.LOCAL_RUNTIME_BUILD_ID?.trim() || `local-runtime-${targetVersion}`;
    const packageSize = Number(process.env.LOCAL_RUNTIME_PACKAGE_SIZE);
    const upgradeId = createHash('sha256')
      .update(`local-runtime:${targetVersion}:${LOCAL_RUNTIME_PROTOCOL_VERSION}:${buildId}`)
      .digest('hex').slice(0, 32);
    return {
      upgradeId,
      subject: 'local-runtime',
      fromVersion: cliVersion,
      toVersion: targetVersion,
      fromProtocolVersion: protocolVersion,
      toProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      toBuildId: buildId,
      releaseNotes,
      installerType: 'windows-nsis',
      mandatory: true,
      ...(releaseUrl ? { releaseUrl } : {}),
      ...(Number.isFinite(packageSize) && packageSize > 0 ? { packageSize } : {}),
      ...(process.env.LOCAL_RUNTIME_PACKAGE_SHA256?.trim() ? { sha256: process.env.LOCAL_RUNTIME_PACKAGE_SHA256.trim() } : {}),
      ...(process.env.LOCAL_RUNTIME_PACKAGE_SIGNATURE?.trim() ? { signature: process.env.LOCAL_RUNTIME_PACKAGE_SIGNATURE.trim() } : {})
    };
  }

  private isUpgradeAvailable(info: LocalRuntimeUpgradeInfo) {
    return Boolean(
      info.releaseUrl
      && info.sha256 && /^[a-f0-9]{64}$/i.test(info.sha256)
      && info.signature && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(info.signature.trim())
    );
  }

  private releaseUrl() {
    const configured = process.env.LOCAL_RUNTIME_RELEASE_URL?.trim();
    if (!configured) return undefined;
    try {
      const url = new URL(configured);
      if (url.protocol !== 'https:' || url.username || url.password) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private issueTokens(device: PersistedDevice): LocalRuntimeTokenResponse {
    const accessToken = token(32);
    const refreshToken = token(48);
    const accessTokenExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    device.accessTokenHash = hash(accessToken);
    device.accessTokenExpiresAt = accessTokenExpiresAt;
    device.refreshTokenHash = hash(refreshToken);
    device.refreshTokenExpiresAt = refreshTokenExpiresAt;
    device.lastSeenAt = new Date().toISOString();
    this.persist();
    return { deviceId: device.deviceId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
  }

  private pruneExpiredCodes() {
    const now = Date.now();
    for (const pending of this.pendingByDeviceCodeHash.values()) {
      if (Date.parse(pending.expiresAt) <= now) this.removePending(pending);
    }
  }

  private removePending(pending: PendingDeviceCode) {
    this.pendingByDeviceCodeHash.delete(pending.deviceCodeHash);
    this.pendingByUserCode.delete(pending.userCode);
  }

  private persist() {
    void this.persistence.setCollection(DEVICES_COLLECTION, [...this.devices.values()]);
  }
}

function publicDevice(device: PersistedDevice): LocalRuntimeDevice {
  const { accessTokenHash: _a, accessTokenExpiresAt: _ae, refreshTokenHash: _r, refreshTokenExpiresAt: _re, ...value } = device;
  return structuredClone(value);
}

function token(bytes: number) {
  return randomBytes(bytes).toString('base64url');
}

function userCodeValue() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const raw = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function isFuture(value: string | undefined) {
  return Boolean(value && Date.parse(value) > Date.now());
}

function compareVersions(left: string, right: string) {
  const parts = (value: string) => value.split(/[.+-]/).slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
