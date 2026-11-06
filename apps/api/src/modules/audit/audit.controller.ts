import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentBranch, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import type { AuthPrincipal } from '../auth/principal';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'Search the audit log (organization-wide, or one branch with branchId)' })
  list(@CurrentUser() user: AuthPrincipal, @CurrentBranch() branchId: string | null, @Query() q: AuditQueryDto) {
    return this.audit.list(user.organizationId, branchId, q);
  }
}
