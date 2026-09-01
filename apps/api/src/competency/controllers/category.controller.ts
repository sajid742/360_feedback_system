import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  CurrentUser,
  ReqContext,
  type AuthUser,
  type RequestContext,
} from '../../common/auth/current-user';
import { CategoryService } from '../services/category.service';
import { CategoryQueryDto, CreateCategoryDto, UpdateCategoryDto } from '../dto/category.dto';
import { COMPETENCY_PERMISSIONS } from '../competency.permissions';

@Controller('competency/categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get()
  @RequirePermissions(COMPETENCY_PERMISSIONS.categoryRead)
  list(@CurrentUser() user: AuthUser, @Query() query: CategoryQueryDto) {
    return this.service.list(user, query);
  }

  @Post()
  @RequirePermissions(COMPETENCY_PERMISSIONS.categoryCreate)
  create(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.service.create(user, ctx, dto);
  }

  @Put(':id')
  @RequirePermissions(COMPETENCY_PERMISSIONS.categoryUpdate)
  update(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.service.update(user, ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions(COMPETENCY_PERMISSIONS.categoryDelete)
  async remove(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(user, ctx, id);
    return { id };
  }
}
