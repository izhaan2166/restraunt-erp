import { AuditModule } from '../audit/audit.module';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, Env } from '../../config/env';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { ModifiersController } from './modifiers.controller';
import { ModifiersService } from './modifiers.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [
    AuditModule,
    // No `dest`: multer keeps the upload in memory (bounded by UPLOAD_MAX_IMAGE_BYTES) so it is sniffed before storing.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ limits: { fileSize: env.UPLOAD_MAX_IMAGE_BYTES, files: 1, fields: 0 } }),
    }),
  ],
  controllers: [MenuController, CategoriesController, ModifiersController, ProductsController],
  providers: [MenuService, CategoriesService, ModifiersService, ProductsService],
  exports: [MenuService],
})
export class MenuModule {}
