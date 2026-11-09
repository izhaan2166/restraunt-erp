import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import type { AuthPrincipal } from '../auth/principal';
import { DashboardService } from './dashboard.service';
import { DashboardQuery, ReportFormat, ReportQuery, SalesReportQuery } from './dto/reports.dto';
import { toCsv, toPdf } from './export';
import { OperationsReportsService } from './operations-reports.service';
import { Report, toJson } from './report';
import { ReportsService } from './reports.service';

/** JSON by default; `format=csv|pdf` downloads the same report as a file. */
async function render(r: Report, format: ReportFormat = 'json') {
  if (format === 'json') return toJson(r);
  if (format === 'table') return r;
  const name = `${r.key}_${r.from}_${r.to}.${format}`;
  if (format === 'csv') return new StreamableFile(Buffer.from(toCsv(r), 'utf8'), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}"` });
  return new StreamableFile(await toPdf(r), { type: 'application/pdf', disposition: `attachment; filename="${name}"` });
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly ops: OperationsReportsService,
    private readonly dash: DashboardService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('dashboard.read', 'any')
  dashboard(@CurrentUser() u: AuthPrincipal, @Query() q: DashboardQuery) {
    return this.dash.get(u, q);
  }

  @Get('reports/sales')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async sales(@CurrentUser() u: AuthPrincipal, @Query() q: SalesReportQuery) {
    return render(await this.reports.sales(u, q), q.format);
  }

  @Get('reports/products')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async products(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.products(u, q), q.format);
  }

  @Get('reports/categories')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async categories(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.categories(u, q), q.format);
  }

  @Get('reports/gst')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.gst', 'any')
  async gst(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.gst(u, q), q.format);
  }

  @Get('reports/discounts')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async discounts(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.discounts(u, q), q.format);
  }

  @Get('reports/refunds')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.financial', 'any')
  async refunds(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.refunds(u, q), q.format);
  }

  @Get('reports/cancellations')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async cancellations(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.cancellations(u, q), q.format);
  }

  @Get('reports/payments')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.financial', 'any')
  async payments(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.reports.payments(u, q), q.format);
  }

  @Get('reports/inventory')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.inventory', 'any')
  async inventory(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.inventory(u, q), q.format);
  }

  @Get('reports/wastage')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.inventory', 'any')
  async wastage(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.wastage(u, q), q.format);
  }

  /** Inventory or financial report rights (the service checks which branches qualify). */
  @Get('reports/purchases')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @AuthenticatedOnly()
  async purchases(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.purchases(u, q), q.format);
  }

  @Get('reports/expenses')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.financial', 'any')
  async expenses(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.expenses(u, q), q.format);
  }

  @Get('reports/profit-loss')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.financial', 'any')
  async profitLoss(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.profitLoss(u, q), q.format);
  }

  @Get('reports/branches')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.sales', 'any')
  async branches(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.branches(u, q), q.format);
  }

  @Get('reports/employees')
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @RequirePermissions('reports.employee', 'any')
  async employees(@CurrentUser() u: AuthPrincipal, @Query() q: ReportQuery) {
    return render(await this.ops.employees(u, q), q.format);
  }
}
