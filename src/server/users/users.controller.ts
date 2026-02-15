import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Get()
    async list() {
        const users = await this.usersService.list();
        return { success: true, data: users };
    }

    @Post()
    async create(@Body() body: { username: string; password: string }) {
        const user = await this.usersService.create(body.username ?? '', body.password ?? '');
        return { success: true, data: user };
    }

    @Put(':id')
    async update(
        @Param('id') id: string,
        @Body() body: { username?: string; password?: string },
    ) {
        const user = await this.usersService.update(id, body);
        return { success: true, data: user };
    }

    @Delete(':id')
    async delete(@Param('id') id: string) {
        await this.usersService.delete(id);
        return { success: true };
    }
}
