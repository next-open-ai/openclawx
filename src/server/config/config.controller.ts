import { Controller, Get, Put, Body, Param, Query } from '@nestjs/common';
import { ConfigService, AppConfig } from './config.service.js';

@Controller('config')
export class ConfigController {
    constructor(private readonly configService: ConfigService) { }

    @Get()
    async getConfig() {
        const config = await this.configService.getConfig();
        const { loginPassword, ...rest } = config as AppConfig & { loginPassword?: string };
        return {
            success: true,
            data: { ...rest, loginPasswordSet: !!loginPassword },
        };
    }

    @Put()
    async updateConfig(@Body() updates: Partial<AppConfig>) {
        const config = await this.configService.updateConfig(updates);
        const { loginPassword, ...rest } = config as AppConfig & { loginPassword?: string };
        return {
            success: true,
            data: { ...rest, loginPasswordSet: !!loginPassword },
        };
    }

    @Get('providers')
    async getProviders() {
        const providers = await this.configService.getProviders();
        return {
            success: true,
            data: providers,
        };
    }

    @Get('provider-support')
    async getProviderSupport() {
        const support = await this.configService.getProviderSupport();
        return {
            success: true,
            data: support,
        };
    }

    @Get('providers/:provider/models')
    async getModels(@Param('provider') provider: string, @Query('type') type?: string) {
        const models = await this.configService.getModels(provider, type);
        return {
            success: true,
            data: models,
        };
    }
}
