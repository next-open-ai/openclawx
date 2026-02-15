import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';

@Module({
    imports: [ConfigModule, UsersModule],
    controllers: [AuthController],
})
export class AuthModule {}
