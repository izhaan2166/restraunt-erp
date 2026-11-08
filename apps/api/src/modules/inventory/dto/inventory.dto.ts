import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockMovementType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';

/** Stock quantities: up to 3 decimals. */
export const STOCK_QTY = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,3})?$/;
/** Purchase prices: up to 4 decimals. */
export const PRICE4 = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
export const PCT = /^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/;
const qtyMsg = (f: string) => ({ message: `${f} must be a number with up to 3 decimals` });

export class CreateIngredientDto {
  @ApiProperty({ example: 'Paneer' }) @IsString() @MinLength(1) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) sku?: string;
  @ApiProperty({ example: 'g', description: 'Stock is kept in this unit: g, ml or pc' }) @IsString() @MaxLength(10) baseUnit: string;
  @ApiPropertyOptional({ example: 'Dairy' }) @IsOptional() @IsString() @MaxLength(60) category?: string;
}

export class UpdateIngredientDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListIngredientsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

export class StockQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ description: 'Only items below their minimum level' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  lowOnly?: boolean;
}

export class BranchQuery {
  @ApiProperty() @IsUUID() branchId: string;
}

export class LevelDto {
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: '2000' }) @Matches(STOCK_QTY, qtyMsg('minimumLevel')) minimumLevel: string;
}

export class SetLevelsDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ type: [LevelDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => LevelDto) levels: LevelDto[];
}

export class MovementsQuery extends PaginationQuery {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() ingredientId?: string;
  @ApiPropertyOptional({ enum: StockMovementType, isArray: true, description: 'Comma-separated' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsEnum(StockMovementType, { each: true })
  type?: StockMovementType[];
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

class StockLineBase {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: '1.5' }) @Matches(STOCK_QTY, qtyMsg('quantity')) quantity: string;
  @ApiPropertyOptional({ example: 'kg', description: "Unit of the quantity; default the ingredient's base unit" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  unit?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class AdjustmentDto extends StockLineBase {
  @ApiProperty({ enum: ['IN', 'OUT'] }) @IsIn(['IN', 'OUT']) direction: 'IN' | 'OUT';
}

export class WastageDto extends StockLineBase {}

export class CountLineDto {
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: '1200', description: 'Quantity physically counted' }) @Matches(STOCK_QTY, qtyMsg('quantity')) quantity: string;
  @ApiPropertyOptional({ example: 'kg' }) @IsOptional() @IsString() @MaxLength(10) unit?: string;
  @ApiPropertyOptional({ description: 'Cost per counted unit, used to value opening stock' })
  @IsOptional()
  @Matches(PRICE4, { message: 'unitCost must be an amount with up to 4 decimals' })
  unitCost?: string;
}

export class StockCountDto {
  @ApiProperty() @IsUUID() branchId: string;
  @ApiProperty({ example: 'Monthly stock count' }) @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @ApiProperty({ type: [CountLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CountLineDto) counts: CountLineDto[];
}

export class RecipeLineDto {
  @ApiProperty() @IsUUID() ingredientId: string;
  @ApiProperty({ example: '150' }) @Matches(STOCK_QTY, qtyMsg('quantity')) quantity: string;
  @ApiProperty({ example: 'g' }) @IsString() @MaxLength(10) unit: string;
  @ApiPropertyOptional({ example: '5', description: 'Extra % lost in preparation' })
  @IsOptional()
  @Matches(PCT, { message: 'wastagePercent must be between 0 and 100' })
  wastagePercent?: string;
}

export class RecipeQuery {
  @ApiPropertyOptional({ description: 'Recipe of one variant; omit for the product-level recipe' }) @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ description: 'Show the estimated cost with this branch’s average costs' }) @IsOptional() @IsUUID() branchId?: string;
}

export class SetRecipeDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ example: '1', description: 'Portions the recipe makes' })
  @IsOptional()
  @Matches(STOCK_QTY, qtyMsg('yieldQuantity'))
  yieldQuantity?: string;
  @ApiProperty({ type: [RecipeLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RecipeLineDto) items: RecipeLineDto[];
}
