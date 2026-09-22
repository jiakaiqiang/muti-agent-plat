import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { SkillsService, type SkillCategoryInput, type SkillInput } from './skills.service.js';
import type { SkillActor, SkillActorRole } from './skill-registry.js';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list() {
    return ok(this.skills.list());
  }

  @Get('available')
  available(
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string,
    @Query('userId') queryUserId?: string,
    @Query('groupId') queryGroupId?: string
  ) {
    return ok(this.skills.listAvailable(actorFromHeaders(userId ?? queryUserId, groupId ?? queryGroupId, role, 'user')));
  }

  @Get('categories')
  categories() {
    return ok(this.skills.listCategories());
  }

  @Get('categories/available')
  availableCategories(
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string,
    @Query('userId') queryUserId?: string,
    @Query('groupId') queryGroupId?: string
  ) {
    return ok(this.skills.listAvailableCategories(actorFromHeaders(userId ?? queryUserId, groupId ?? queryGroupId, role, 'user')));
  }

  @Post('categories')
  createCategory(
    @Body() body: SkillCategoryInput,
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.createCategory(body, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Patch('categories/:categoryId')
  renameCategory(
    @Param('categoryId') categoryId: string,
    @Body() body: { name: string },
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.renameCategory(categoryId, body.name, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Delete('categories/:categoryId')
  removeCategory(
    @Param('categoryId') categoryId: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.removeCategory(categoryId, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Get(':skillId')
  detail(@Param('skillId') skillId: string) {
    return ok(this.skills.get(skillId));
  }

  @Get(':skillId/references')
  references(@Param('skillId') skillId: string) {
    return ok({ agents: this.skills.referencingAgents(skillId) });
  }

  @Post()
  create(
    @Body() body: SkillInput,
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.create(body, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Patch(':skillId')
  update(
    @Param('skillId') skillId: string,
    @Body() body: Partial<SkillInput>,
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.update(skillId, body, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Delete(':skillId')
  remove(
    @Param('skillId') skillId: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.remove(skillId, actorFromHeaders(userId, groupId, role, 'user')));
  }

  @Post(':skillId/promote-to-group')
  promoteToGroup(
    @Param('skillId') skillId: string,
    @Body() body: { groupId: string },
    @Headers('x-user-id') userId?: string,
    @Headers('x-group-id') groupId?: string,
    @Headers('x-skill-role') role?: string
  ) {
    return ok(this.skills.promoteToGroup(skillId, body.groupId, actorFromHeaders(userId, groupId, role, 'user')));
  }
}

function actorFromHeaders(
  userId: string | undefined,
  groupId: string | undefined,
  role: string | undefined,
  fallbackRole?: SkillActorRole
): SkillActor | undefined {
  if (!userId && !groupId && !role && !fallbackRole) return undefined;
  const resolvedRole: SkillActorRole = role === 'system_admin' || role === 'group_admin' || role === 'user'
    ? role
    : fallbackRole ?? 'user';
  return {
    userId: userId?.trim() || 'local-user',
    role: resolvedRole,
    groupId: groupId?.trim() || undefined,
    groupIds: groupId?.trim() ? [groupId.trim()] : []
  };
}
