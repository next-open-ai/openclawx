import { Controller, Get, Post, Body } from '@nestjs/common';
import { UsageService, RecordTokenUsageDto, TokenUsageTotal } from './usage.service.js';

@Controller('usage')
export class UsageController {
    constructor(private readonly usageService: UsageService) {}

    @Post()
    record(@Body() dto: RecordTokenUsageDto): { success: boolean } {
        this.usageService.recordUsage(dto);
        return { success: true };
    }

    @Get('total')
    getTotal(): { success: boolean; data: TokenUsageTotal } {
        const data = this.usageService.getTotal();
        return { success: true, data };
    }
}
