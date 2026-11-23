import { ipKey, RateLimitService, slidingWindow } from '../http/rate-limit/rate-limit.service';
import { isLocalEnv } from './tokens';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type { CookieOptions, Request, Response } from 'express';
import { Public } from '../common/decorators';
import { decodeIdOr404 } from '../common/ids';
import { ProblemException } from '../common/problem';
import { ApiKeyAuthService } from '../modules/api-keys/api-key-auth.service';
import { ApiServiceBusyResponse } from './auth-tx';
import { AuthService, type ClientInfo, type TokenPair } from './auth.service';
import { jwks } from './signing-keys';

/** code_verifier/challenge ตาม RFC 7636 (43–128 ตัว unreserved) */
const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/;

export class LoginDto {
  @ApiProperty({ example: 'owner@example.co.th' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;

  @ApiProperty({ description: 'PKCE S256: BASE64URL(SHA256(code_verifier))' })
  @Matches(PKCE)
  codeChallenge!: string;

  @ApiPropertyOptional({
    example: 'ten_…',
    description: 'ระบุเมื่อ API ตอบ tenant_selection_required (อีเมลเป็นสมาชิกหลายบริษัท)',
  })
  @IsOptional()
  @IsString()
  tenantId?: string;
}

export class LoginResultDto {
  @ApiProperty({ description: 'authorization code ใช้ครั้งเดียว อายุ 60 วินาที' }) code!: string;
  @ApiProperty({ example: 60 }) expiresIn!: number;
}

const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials'] as const;
type GrantType = (typeof GRANT_TYPES)[number];

/**
 * คำขอ token — รับได้ 2 รูปแบบ (D-81 · D68-42 · 23 พ.ย. 2569, docs/04 G1 "OAuth2 client credentials"):
 * - JSON camelCase (เดิม: `grantType`, `clientId`, `clientSecret`, `codeVerifier`)
 * - `application/x-www-form-urlencoded` ชื่อ snake_case ตาม RFC 6749 (`grant_type`, `client_id`, `client_secret`, `code_verifier`)
 * ส่งชื่อแบบใดแบบหนึ่ง (ส่งทั้งสองแบบแล้วค่าไม่ตรงกัน → 422)
 */
export class TokenRequestDto {
  @ApiPropertyOptional({
    enum: GRANT_TYPES,
    description:
      'client_credentials (ST7-T01) = client ภายนอกด้วย API key: clientId `key_…` + clientSecret `tk_live_…` (หรือ HTTP Basic) → JWT RS256 1 ชม. · ต้องส่ง grantType หรือ grant_type',
  })
  @IsOptional()
  @IsIn(GRANT_TYPES)
  grantType?: GrantType;

  @ApiPropertyOptional({ enum: GRANT_TYPES, description: 'RFC 6749 — เหมือน grantType' })
  @IsOptional()
  @IsIn(GRANT_TYPES)
  grant_type?: GrantType;

  @ApiPropertyOptional({ description: 'grantType=authorization_code' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string;

  @ApiPropertyOptional({ description: 'grantType=authorization_code (PKCE)' })
  @IsOptional()
  @Matches(PKCE)
  codeVerifier?: string;

  @ApiPropertyOptional({ description: 'RFC 6749/7636 — เหมือน codeVerifier' })
  @IsOptional()
  @Matches(PKCE)
  code_verifier?: string;

  @ApiPropertyOptional({
    example: 'tk_live_8f3a',
    description:
      'grantType=client_credentials — id ของ key (`key_…`) หรือ prefix ที่แสดงในหน้าจอ · หรือส่งใน Authorization: Basic',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;

  @ApiPropertyOptional({ description: 'RFC 6749 — เหมือน clientId' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  client_id?: string;

  @ApiPropertyOptional({
    description: 'grantType=client_credentials — API key เต็ม (`tk_live_…`)',
    format: 'password',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientSecret?: string;

  @ApiPropertyOptional({ description: 'RFC 6749 — เหมือน clientSecret', format: 'password' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  client_secret?: string;

  @ApiPropertyOptional({
    example: 'orders:read orders:write',
    description:
      'grantType=client_credentials — scope ที่ขอ (คั่นด้วยช่องว่าง ⊆ scope ของ key; ไม่ส่ง = ทั้งหมด)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  scope?: string;
}

/** รวมชื่อ camelCase / snake_case (RFC 6749) เป็นค่าเดียว — ส่งทั้งคู่แต่ไม่ตรงกัน = 422 */
export function normalizeTokenRequest(b: TokenRequestDto): {
  grantType: GrantType;
  code?: string;
  codeVerifier?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
} {
  const errors: { field: string; code: string; message: string }[] = [];
  const pick = <T>(camel: keyof TokenRequestDto, snake: keyof TokenRequestDto): T | undefined => {
    const a = b[camel] as T | undefined;
    const s = b[snake] as T | undefined;
    if (a !== undefined && s !== undefined && a !== s)
      errors.push({
        field: String(snake),
        code: 'conflict',
        message: `${String(camel)} and ${String(snake)} differ`,
      });
    return a ?? s;
  };
  const grantType = pick<GrantType>('grantType', 'grant_type');
  const codeVerifier = pick<string>('codeVerifier', 'code_verifier');
  const clientId = pick<string>('clientId', 'client_id');
  const clientSecret = pick<string>('clientSecret', 'client_secret');
  if (!grantType)
    errors.push({
      field: 'grantType',
      code: 'isIn',
      message: 'grantType or grant_type is required',
    });
  if (errors.length || !grantType)
    throw new ProblemException('validation_failed', undefined, errors);
  return { grantType, code: b.code, codeVerifier, clientId, clientSecret, scope: b.scope };
}

export class TokenDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: 900, description: 'วินาที' }) expiresIn!: number;
  @ApiPropertyOptional({ description: 'client_credentials: scope ที่ได้จริง' }) scope?: string;
  @ApiPropertyOptional({
    description:
      'RFC 6749 §5.1 — มีเฉพาะเมื่อขอแบบ application/x-www-form-urlencoded (ค่าเดียวกับ accessToken)',
  })
  access_token?: string;
  @ApiPropertyOptional({ example: 'Bearer', description: 'RFC 6749 §5.1 — เฉพาะคำขอแบบ form' })
  token_type?: string;
  @ApiPropertyOptional({ example: 3600, description: 'RFC 6749 §5.1 — เฉพาะคำขอแบบ form' })
  expires_in?: number;
}

/** คำขอแบบ form (RFC 6749) → ตอบชื่อ snake_case ตาม §5.1 ด้วย (คงชื่อ camelCase เดิมไว้ — ไม่เปลี่ยนสัญญา JSON) */
function withRfcFields(req: Request, t: TokenDto): TokenDto {
  if (!req.is('application/x-www-form-urlencoded')) return t;
  return { ...t, access_token: t.accessToken, token_type: t.tokenType, expires_in: t.expiresIn };
}

export class JwksDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'RSA public keys (RFC 7517) ที่ใช้ตรวจ token ของ client credentials',
  })
  keys!: Record<string, unknown>[];
}

/** HTTP Basic (RFC 6749 §2.3.1) → [client_id, client_secret] */
function basicCredentials(req: Request): [string, string] | null {
  const h = req.header('authorization') ?? '';
  if (!h.startsWith('Basic ')) return null;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return null;
  try {
    return [decodeURIComponent(raw.slice(0, i)), decodeURIComponent(raw.slice(i + 1))];
  } catch {
    return null;
  }
}

/**
 * review T-1 (login CSRF): grant ที่ตั้ง cookie (`authorization_code`, `refresh_token`) รับเฉพาะคำขอจากหน้าเว็บของเราเอง
 * - body แบบ form (ส่งข้ามเว็บได้โดยไม่ preflight) → 403 · form ใช้ได้เฉพาะ `client_credentials` (API client ไม่มี cookie)
 * - `Sec-Fetch-Site` ต้องเป็น same-origin / none / ไม่ส่ง (client ที่ไม่ใช่เบราว์เซอร์) — อื่น ๆ ผ่านได้เมื่อ `Origin` ตรงกับ
 *   `PUBLIC_WEB_BASE_URL` (เว็บอยู่คนละ origin กับ API) · ไม่ผ่าน → 403 `forbidden`
 */
export function assertCookieGrantSameSite(req: Request): void {
  if (req.is('application/x-www-form-urlencoded'))
    throw new ProblemException(
      'forbidden',
      'this grant sets a session cookie and accepts JSON only (form bodies are for client_credentials)',
    );
  const site = req.header('sec-fetch-site');
  if (site === undefined || site === 'same-origin' || site === 'none') return;
  const web = process.env.PUBLIC_WEB_BASE_URL;
  const origin = req.header('origin');
  let allowed = false;
  try {
    allowed = !!web && !!origin && new URL(web).origin === new URL(origin).origin;
  } catch {
    allowed = false;
  }
  if (!allowed)
    throw new ProblemException('forbidden', 'cross-site request to a cookie-setting grant');
}

export const REFRESH_COOKIE = 'tms_rt';
const COOKIE_PATH = '/v1/oauth';

function cookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: !isLocalEnv(),
    sameSite: 'strict',
    path: COOKIE_PATH,
    ...(expires ? { expires } : {}),
  };
}

function clientOf(req: Request): ClientInfo {
  return { ip: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? undefined };
}

/**
 * Login ของ UI (ST1-T01, T04) — Authorization Code + PKCE (plan/02 T-04)
 * 1) POST /auth/login → code  2) POST /oauth/token (authorization_code + codeVerifier) → access token + refresh cookie
 * 3) POST /oauth/token (refresh_token, อ่านจาก httpOnly cookie) → access token ใหม่  4) POST /oauth/revoke ออกจากระบบ
 */
/** ST7-T08: เพดานขอ token (`POST /oauth/token`) — หน้าต่างเลื่อน 1 นาที */
export const TOKEN_PER_IP_PER_MIN = Number(process.env.TOKEN_RATE_LIMIT_PER_IP_PER_MIN ?? 120);
export const TOKEN_PER_CLIENT_PER_MIN = 30;

@ApiTags('auth')
@Public()
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeyAuthService,
    private readonly limiter: RateLimitService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiOkResponse({ type: LoginResultDto })
  @ApiUnauthorizedResponse({ description: 'invalid_credentials' })
  @ApiConflictResponse({
    description: 'tenant_selection_required — มี `tenants: [{id, name, status}]`',
  })
  @ApiTooManyRequestsResponse({ description: 'account_locked — มี header Retry-After' })
  @ApiServiceBusyResponse()
  @ApiUnauthorizedResponse({
    description:
      'mfa_required / mfa_enrollment_required — มี `mfaToken` ใช้ต่อที่ /v1/auth/2fa/verify หรือ /v1/auth/2fa/enroll',
  })
  async login(@Body() body: LoginDto, @Req() req: Request): Promise<LoginResultDto> {
    const tenantId = body.tenantId ? decodeIdOr404('tenant', body.tenantId) : undefined;
    return this.auth.login(
      {
        email: body.email,
        password: body.password,
        codeChallenge: body.codeChallenge,
        tenantId,
        trustedDevice: req.cookies?.['tms_td'] as string | undefined,
      },
      clientOf(req),
    );
  }

  @Post('oauth/token')
  @HttpCode(200)
  @ApiConsumes('application/json', 'application/x-www-form-urlencoded')
  @ApiOkResponse({
    type: TokenDto,
    description:
      'authorization_code / refresh_token: ตั้ง refresh token ใน cookie httpOnly `tms_rt` — รับเฉพาะ JSON จากหน้าเว็บเดียวกัน (form / `Sec-Fetch-Site` ข้ามเว็บ → 403 `forbidden`) · client_credentials: รับ JSON หรือ form (RFC 6749) ไม่มี refresh token (error: 401 invalid_client / key_revoked / key_expired, 400 invalid_scope, 403 ip_not_allowed)',
  })
  @ApiTooManyRequestsResponse({
    description: `rate_limited — เกิน ${TOKEN_PER_IP_PER_MIN} ครั้ง/นาที ต่อ IP หรือ ${TOKEN_PER_CLIENT_PER_MIN} ครั้ง/นาที ต่อ client id (client_credentials) มี header Retry-After`,
  })
  async token(
    @Body() raw: TokenRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenDto> {
    let pair: TokenPair;
    const body = normalizeTokenRequest(raw);
    const basic = body.grantType === 'client_credentials' ? basicCredentials(req) : null;
    const id = basic?.[0] ?? body.clientId;
    // ST7-T08 (review M3): จำกัดก่อนตรวจรหัส (กันเดา secret) — ต่อ IP ทุก grant + ต่อ client id · ฐานใช้ไม่ได้ = 503
    await this.limiter.assert(
      [
        slidingWindow(`otk:ip:${ipKey(req.ip)}`, TOKEN_PER_IP_PER_MIN, 60_000, 'ip'),
        ...(body.grantType === 'client_credentials' && id
          ? [
              slidingWindow(
                `otk:c:${String(id).slice(0, 100)}`,
                TOKEN_PER_CLIENT_PER_MIN,
                60_000,
                'key',
              ),
            ]
          : []),
      ],
      res,
    );
    if (body.grantType === 'client_credentials') {
      const sec = basic?.[1] ?? body.clientSecret;
      if (!id || !sec) throw new ProblemException('invalid_client');
      const t = await this.apiKeys.issueToken(id, sec, body.scope, req.ip);
      res.setHeader('Cache-Control', 'no-store');
      return withRfcFields(req, {
        accessToken: t.accessToken,
        tokenType: 'Bearer',
        expiresIn: t.expiresIn,
        scope: t.scope,
      });
    }
    assertCookieGrantSameSite(req); // review T-1 — ก่อนตรวจ code/cookie
    if (body.grantType === 'authorization_code') {
      if (!body.code || !body.codeVerifier) throw new ProblemException('invalid_grant');
      pair = await this.auth.exchangeCode(body.code, body.codeVerifier, clientOf(req));
    } else {
      // refresh ของ UI อ่าน cookie เท่านั้น (form/ข้ามเว็บถูกกันที่ assertCookieGrantSameSite แล้ว)
      // (`refresh_token` ใน body ตาม RFC 6749 §6 มากับงาน Auth Code + PKCE/RS256 ของ UI ก่อนเปิด Open API — D68-42)
      const rt = req.cookies?.[REFRESH_COOKIE] as string | undefined;
      // ไม่มี cookie เลย = ไม่ได้ login (401 — เว็บไม่ต้องลองซ้ำ; 400 สงวนไว้สำหรับ cookie ที่เพิ่งถูกหมุน)
      if (!rt) throw new ProblemException('unauthorized');
      try {
        pair = await this.auth.refresh(rt, clientOf(req));
      } catch (e) {
        res.clearCookie(REFRESH_COOKIE, cookieOptions());
        throw e;
      }
    }
    res.cookie(REFRESH_COOKIE, pair.refreshToken, cookieOptions(pair.refreshExpiresAt));
    res.setHeader('Cache-Control', 'no-store');
    return withRfcFields(req, {
      accessToken: pair.accessToken,
      tokenType: 'Bearer',
      expiresIn: pair.expiresIn,
    });
  }

  /** กุญแจสาธารณะสำหรับตรวจ token ของ client credentials (RS256) — หมุนกุญแจดู auth/signing-keys.ts */
  @Get('.well-known/jwks.json')
  @ApiOkResponse({ type: JwksDto })
  async jwks(@Res({ passthrough: true }) res: Response): Promise<JwksDto> {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return (await jwks()) as unknown as JwksDto;
  }

  @Post('oauth/revoke')
  @HttpCode(204)
  @ApiNoContentResponse()
  async revoke(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
  }
}
