import { Module } from '@nestjs/common';
import { UsageService } from './usage.service.js';
import { UsageController } from './usage.controller.js';

@Module({
    controllers: [UsageController],
    providers: [UsageService],
    exports: [UsageService],
})
export class UsageModule {}
