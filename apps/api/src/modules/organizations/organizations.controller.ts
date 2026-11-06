import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../auth/principal';
import { UpdateOrganizationDto } from './dto/organization.dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('organization')
@ApiBearerAuth()
@Controller('organization')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermissions('organization.read', 'org')
  get(@CurrentUser() user: AuthPrincipal) {
    return this.orgs.get(user);
  }

  @Patch()
  @RequirePermissions('organization.update', 'org')
  @ApiOperation({ summary: 'Update legal/GST details of the organization' })
  update(@CurrentUser() user: AuthPrincipal, @Body() dto: UpdateOrganizationDto, @Req() req: Request) {
    return this.orgs.update(user, dto, requestMeta(req));
  }
}
