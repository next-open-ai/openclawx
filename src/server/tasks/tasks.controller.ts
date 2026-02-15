import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { TasksService, ScheduledTask, RepeatRule } from './tasks.service.js';

@Controller('tasks')
export class TasksController {
    constructor(private readonly tasksService: TasksService) {}

    @Get()
    list() {
        const data = this.tasksService.list();
        return { success: true, data };
    }

    @Get('due')
    getDue(@Query('at') atStr?: string) {
        const at = atStr ? new Date(atStr) : new Date();
        const data = this.tasksService.getDueTasks(at);
        return { success: true, data };
    }

    @Get('executions/:eid')
    getExecution(@Param('eid') eid: string) {
        const execution = this.tasksService.getExecution(eid);
        if (!execution) {
            throw new HttpException('Execution not found', HttpStatus.NOT_FOUND);
        }
        return { success: true, data: execution };
    }

    @Get(':id/executions')
    listExecutions(@Param('id') id: string) {
        const task = this.tasksService.get(id);
        if (!task) {
            throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
        }
        const data = this.tasksService.listExecutions(id);
        return { success: true, data };
    }

    @Delete(':id/executions')
    clearExecutions(@Param('id') id: string) {
        const task = this.tasksService.get(id);
        if (!task) {
            throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
        }
        const deleted = this.tasksService.deleteExecutionsByTaskId(id);
        return { success: true, data: { deleted } };
    }

    @Get(':id')
    get(@Param('id') id: string) {
        const task = this.tasksService.get(id);
        if (!task) {
            throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
        }
        return { success: true, data: task };
    }

    @Post()
    create(
        @Body()
        body: {
            workspace: string;
            message: string;
            scheduleType: 'once' | 'cron';
            runAt?: number;
            cronExpr?: string;
            repeatRule?: RepeatRule;
        },
    ) {
        const task = this.tasksService.create({
            workspace: body.workspace ?? 'default',
            message: body.message,
            scheduleType: body.scheduleType,
            runAt: body.runAt,
            cronExpr: body.cronExpr,
            repeatRule: body.repeatRule,
        });
        return { success: true, data: task };
    }

    @Put(':id')
    update(
        @Param('id') id: string,
        @Body()
        body: Partial<Pick<ScheduledTask, 'message' | 'enabled' | 'scheduleType' | 'runAt' | 'cronExpr' | 'repeatRuleJson'>>,
    ) {
        const task = this.tasksService.update(id, body);
        if (!task) {
            throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
        }
        return { success: true, data: task };
    }

    @Delete(':id')
    delete(@Param('id') id: string) {
        const ok = this.tasksService.delete(id);
        if (!ok) {
            throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
        }
        return { success: true };
    }

    @Post(':id/ran')
    markRan(@Param('id') id: string) {
        this.tasksService.markRan(id);
        return { success: true };
    }
}
