import { Controller, Post, Body, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { UsersService } from '../users/users.service.js';

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly configService: ConfigService,
        private readonly usersService: UsersService,
    ) {}

    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Body() body: { username?: string; password?: string }) {
        const user = (body.username ?? '').trim().toLowerCase();
        const pass = (body.password ?? '').trim();

        // 系统缺省：admin / 123456 始终允许登录，并确保缺省用户存在
        if (user === DEFAULT_USERNAME && pass === DEFAULT_PASSWORD) {
            const defaultUser = await this.usersService.ensureDefaultAdmin();
            return { success: true, user: defaultUser };
        }

        const hasUsers = await this.usersService.hasUsers();
        if (hasUsers) {
            const ok = await this.usersService.validateCredentials(
                body.username ?? '',
                body.password ?? '',
            );
            if (ok) {
                const found = await this.usersService.findByUsername(body.username ?? '');
                return { success: true, user: found ?? undefined };
            }
            throw new UnauthorizedException('Invalid username or password');
        }
        const config = await this.configService.getConfig();
        const expectedUser = (config.loginUsername?.trim() || DEFAULT_USERNAME).toLowerCase();
        const expectedPass = config.loginPassword?.trim() || DEFAULT_PASSWORD;
        if (user === expectedUser && pass === expectedPass) {
            return { success: true };
        }
        throw new UnauthorizedException('Invalid username or password');
    }
}
