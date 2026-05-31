import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ModelInput, ModelsService } from './models.service.js';

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  list() {
    return ok(this.models.list());
  }

  @Get(':modelId')
  detail(@Param('modelId') modelId: string) {
    return ok(this.models.get(modelId));
  }

  @Post()
  create(@Body() body: ModelInput) {
    return ok(this.models.create(body ?? {}));
  }

  @Patch(':modelId')
  update(@Param('modelId') modelId: string, @Body() body: ModelInput) {
    return ok(this.models.update(modelId, body ?? {}));
  }

  @Delete(':modelId')
  remove(@Param('modelId') modelId: string) {
    return ok(this.models.remove(modelId));
  }
}
