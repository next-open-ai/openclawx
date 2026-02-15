import { Controller, Get, Post, Put, Delete, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { TagsService } from './tags.service.js';

@Controller('tags')
export class TagsController {
    constructor(private readonly tagsService: TagsService) {}

    @Get()
    async list() {
        const data = await this.tagsService.findAll();
        return { success: true, data };
    }

    @Get(':id')
    async get(@Param('id') id: string) {
        const data = await this.tagsService.findById(id);
        if (!data) throw new HttpException('Tag not found', HttpStatus.NOT_FOUND);
        return { success: true, data };
    }

    @Post()
    async create(@Body() body: { name: string; sortOrder?: number }) {
        const data = await this.tagsService.create({
            name: body.name,
            sortOrder: body.sortOrder,
        });
        return { success: true, data };
    }

    @Put(':id')
    async update(@Param('id') id: string, @Body() body: { name?: string; sortOrder?: number }) {
        const data = await this.tagsService.update(id, body);
        return { success: true, data };
    }

    @Delete(':id')
    async delete(@Param('id') id: string) {
        await this.tagsService.delete(id);
        return { success: true };
    }
}
