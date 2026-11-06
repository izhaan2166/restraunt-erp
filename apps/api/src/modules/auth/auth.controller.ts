import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Env, ENV } from '../../config/env';
import { AuthThrottle, AuthenticatedOnly, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import { Errors } from '../../common/errors/app-error';
import { requestMeta } from '../../common/http/request-meta';
import { AuthService, IssuedTokens } from './auth.service';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, ResetPasswordDto, TokenPairResponse } from './dto/auth.dto';
import type { AuthPrincipal } from './principal';

export const REFRESH_COOKIE = 'ros_rt';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({ type: TokenPairResponse })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto.email, dto.password, requestMeta(req));
    return this.respondWithTokens(res, tokens);
  }

  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  @ApiOkResponse({ type: TokenPairResponse })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = this.readRefreshToken(dto, req);
    try {
      const tokens = await this.auth.refresh(raw, requestMeta(req));
      return this.respondWithTokens(res, tokens);
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out the current session (bearer token or refresh cookie)' })
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Public so a client whose access token already expired can still end its session.
    await this.auth.logoutByRefreshToken(this.readRefreshToken(dto, req), requestMeta(req));
    this.clearCookie(res);
  }

  @AuthenticatedOnly()
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out every session of the current user' })
  async logoutAll(@CurrentUser() user: AuthPrincipal, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user, requestMeta(req), true);
    this.clearCookie(res);
  }

  @Public()
  @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Email a password reset link (same response whether or not the account exists)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, requestMeta(req));
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public()
  @AuthThrottle()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password with a reset token; signs out all sessions' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, requestMeta(req));
  }

  @AuthenticatedOnly()
  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change own password; signs out other sessions' })
  async changePassword(@CurrentUser() user: AuthPrincipal, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword, requestMeta(req));
  }

  @AuthenticatedOnly()
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current user, organization, branches and effective permissions' })
  me(@CurrentUser() user: AuthPrincipal) {
    return this.auth.me(user);
  }

  // ───────────── cookie helpers ─────────────

  private respondWithTokens(res: Response, t: IssuedTokens): TokenPairResponse {
    res.cookie(REFRESH_COOKIE, t.refreshToken, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: t.refreshExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return {
      accessToken: t.accessToken,
      expiresIn: t.expiresIn,
      refreshToken: t.refreshToken,
      refreshExpiresAt: t.refreshExpiresAt.toISOString(),
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH, httpOnly: true, sameSite: 'strict', secure: this.env.COOKIE_SECURE });
  }

  /**
   * Body token wins (native/POS clients). When the cookie is used, the request must come from an
   * allowed origin: SameSite=Strict plus this Origin check is our CSRF defence for the cookie flow.
   */
  private readRefreshToken(dto: RefreshDto, req: Request): string | undefined {
    if (dto.refreshToken) return dto.refreshToken;
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const fromCookie = cookies?.[REFRESH_COOKIE];
    if (!fromCookie) return undefined;
    const origin = req.get('origin');
    if (origin && !this.env.CORS_ORIGINS.includes(origin)) {
      throw Errors.forbidden('ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
    }
    return fromCookie;
  }
}
