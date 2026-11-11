import { isLocalEnv } from './tokens';
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiConflictResponse,
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
import { AuthService, type ClientInfo, type TokenPair } from './auth.service';

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

export class TokenRequestDto {
  @ApiProperty({ enum: ['authorization_code', 'refresh_token'] })
  @IsIn(['authorization_code', 'refresh_token'])
  grantType!: 'authorization_code' | 'refresh_token';

  @ApiPropertyOptional({ description: 'grantType=authorization_code' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string;

  @ApiPropertyOptional({ description: 'grantType=authorization_code (PKCE)' })
  @IsOptional()
  @Matches(PKCE)
  codeVerifier?: string;
}

export class TokenDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: 900, description: 'วินาที' }) expiresIn!: number;
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
@ApiTags('auth')
@Public()
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiOkResponse({ type: LoginResultDto })
  @ApiUnauthorizedResponse({ description: 'invalid_credentials' })
  @ApiConflictResponse({
    description: 'tenant_selection_required — มี `tenants: [{id, name, status}]`',
  })
  @ApiTooManyRequestsResponse({ description: 'account_locked — มี header Retry-After' })
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
  @ApiOkResponse({ type: TokenDto, description: 'ตั้ง refresh token ใน cookie httpOnly `tms_rt`' })
  async token(
    @Body() body: TokenRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenDto> {
    let pair: TokenPair;
    if (body.grantType === 'authorization_code') {
      if (!body.code || !body.codeVerifier) throw new ProblemException('invalid_grant');
      pair = await this.auth.exchangeCode(body.code, body.codeVerifier, clientOf(req));
    } else {
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
    return { accessToken: pair.accessToken, tokenType: 'Bearer', expiresIn: pair.expiresIn };
  }

  @Post('oauth/revoke')
  @HttpCode(204)
  @ApiNoContentResponse()
  async revoke(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
  }
}
