import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus, OrderType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';
import { MONEY, QTY } from '../../menu/dto/menu.dto';

export class OrderModifierInputDto {
  @ApiProperty() @IsUUID() modifierId: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(20) quantity?: number;
}

export class OrderItemInputDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional({ description: 'Required when the product has variants' }) @IsOptional() @IsUUID() variantId?: string;
  @ApiProperty({ example: '2' }) @Matches(QTY, { message: 'quantity must be a positive number with up to 3 decimals' }) quantity: string;
  @ApiPropertyOptional({ type: [OrderModifierInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OrderModifierInputDto)
  modifiers?: OrderModifierInputDto[];
  @ApiPropertyOptional({ example: 'Less spicy' }) @IsOptional() @IsString() @MaxLength(300) instructions?: string;
  @ApiPropertyOptional({ description: 'Price override per unit; needs billing.price.override and a reason' })
  @IsOptional()
  @Matches(MONEY, { message: 'unitPriceOverride must be an amount with up to 2 decimals' })
  unitPriceOverride?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(200) overrideReason?: string;
}

export class CreateOrderDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ enum: OrderType }) @IsEnum(OrderType) orderType: OrderType;
  @ApiPropertyOptional({ description: 'Required for DINE_IN: the table must be open' }) @IsOptional() @IsUUID() tableId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) customerName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'customerPhone must be 10–15 digits' }) customerPhone?: string;
  @ApiPropertyOptional({ description: 'Required for DELIVERY' }) @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(200) guestCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiProperty({ type: [OrderItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];
}

export class ItemQuantityDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @Matches(QTY) quantity: string;
}

export class RemoveItemDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ example: 'Customer changed mind' }) @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

export class UpdateOrderDto {
  @ApiProperty({ description: 'The version you last read; stale versions get 409 CONCURRENT_UPDATE' }) @IsInt() @Min(0) version: number;
  @ApiPropertyOptional({ type: [OrderItemInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  addItems?: OrderItemInputDto[];
  @ApiPropertyOptional({ type: [ItemQuantityDto], description: 'Only for items not yet sent to the kitchen' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemQuantityDto)
  updateItems?: ItemQuantityDto[];
  @ApiPropertyOptional({ type: [RemoveItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RemoveItemDto)
  removeItems?: RemoveItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) customerName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/) customerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ApplyDiscountDto {
  @ApiProperty({ enum: ['ORDER', 'ITEM'] }) @IsIn(['ORDER', 'ITEM']) scope: 'ORDER' | 'ITEM';
  @ApiProperty({ enum: ['PERCENTAGE', 'FIXED'] }) @IsIn(['PERCENTAGE', 'FIXED']) type: 'PERCENTAGE' | 'FIXED';
  @ApiProperty({ example: '10' }) @Matches(MONEY) value: string;
  @ApiPropertyOptional({ description: 'Required when scope is ITEM' }) @IsOptional() @IsUUID() orderItemId?: string;
  @ApiProperty({ example: 'Regular customer' }) @IsString() @MinLength(3) @MaxLength(200) reason: string;
  @ApiProperty() @IsInt() @Min(0) version: number;
}

export class VersionDto {
  @ApiProperty() @IsInt() @Min(0) version: number;
}

export class ChangeStatusDto extends VersionDto {
  @ApiProperty({ enum: OrderStatus }) @IsEnum(OrderStatus) status: OrderStatus;
}

export class ReasonDto extends VersionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ListOrdersQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ enum: OrderStatus, isArray: true, description: 'Comma-separated' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsEnum(OrderStatus, { each: true })
  status?: OrderStatus[];
  @ApiPropertyOptional({ enum: OrderType }) @IsOptional() @IsEnum(OrderType) type?: OrderType;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() tableSessionId?: string;
  @ApiPropertyOptional({ description: 'Only orders changed at or after this time (resync after a reconnect)' })
  @IsOptional()
  @IsDateString()
  updatedSince?: string;
}
