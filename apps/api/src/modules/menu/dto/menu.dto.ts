import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../../common/dto/pagination';

export const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
export const QTY = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,3})?$/;
const money = (field: string) => ({ message: `${field} must be a non-negative amount with up to 2 decimals, e.g. "249.00"` });

// ───────────── Categories ─────────────

export class CreateCategoryDto {
  @ApiProperty({ example: 'Starters' }) @IsString() @MinLength(1) @MaxLength(60) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ───────────── Variants ─────────────

export class VariantInputDto {
  @ApiProperty({ example: 'Full' }) @IsString() @MinLength(1) @MaxLength(40) name: string;
  @ApiProperty({ example: '320.00' }) @Matches(MONEY, money('price')) price: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateVariantDto extends PartialType(VariantInputDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ───────────── Combos ─────────────

export class ComboItemInputDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiProperty({ example: '1' }) @Matches(QTY, { message: 'quantity must be a positive number' }) quantity: string;
}

export class SetComboItemsDto {
  @ApiProperty({ type: [ComboItemInputDto] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ComboItemInputDto)
  items: ComboItemInputDto[];
}

// ───────────── Products ─────────────

export class CreateProductDto {
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty({ example: 'STR-PNR-TIKKA' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9][A-Z0-9_-]{0,39}$/, { message: 'sku must be 1–40 chars of A–Z, 0–9, _ or -' })
  sku: string;
  @ApiProperty({ example: 'Paneer Tikka' }) @IsString() @MinLength(1) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ example: '280.00' }) @Matches(MONEY, money('basePrice')) basePrice: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() taxRateId?: string;
  @ApiPropertyOptional({ example: '996331', description: 'HSN/SAC code (SAC 996331 for restaurant service)' })
  @IsOptional()
  @Matches(/^[0-9]{4,8}$/, { message: 'hsnSac must be 4–8 digits' })
  hsnSac?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isVeg?: boolean;
  @ApiPropertyOptional({ example: 'MAIN', description: 'Kitchen station code that prepares this item' })
  @IsOptional()
  @Matches(/^[A-Z0-9_-]{2,20}$/)
  stationCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isCombo?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;

  @ApiPropertyOptional({ type: [VariantInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VariantInputDto)
  variants?: VariantInputDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  modifierGroupIds?: string[];

  @ApiPropertyOptional({ type: [ComboItemInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ComboItemInputDto)
  comboItems?: ComboItemInputDto[];
}

export class UpdateProductDto extends PartialType(OmitType(CreateProductDto, ['variants', 'comboItems', 'isCombo'] as const)) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListProductsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}

export class SetModifierGroupsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  groupIds: string[];
}

// ───────────── Branch pricing & availability ─────────────

export class BranchPriceOverrideDto {
  @ApiPropertyOptional({ nullable: true, description: 'null = the product itself (no variant)' })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  variantId: string | null = null;

  @ApiPropertyOptional({ nullable: true, example: '300.00', description: 'null = keep the menu price' })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Matches(MONEY, money('price'))
  price: string | null = null;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isAvailable: boolean = true;
}

export class SetBranchPricesDto {
  @ApiProperty() @IsUUID() branchId: string;

  @ApiProperty({ type: [BranchPriceOverrideDto], description: 'Replaces every override of this product in the branch' })
  @IsArray()
  @ArrayMaxSize(21)
  @ValidateNested({ each: true })
  @Type(() => BranchPriceOverrideDto)
  overrides: BranchPriceOverrideDto[];
}

export class SetAvailabilityDto {
  @ApiPropertyOptional({ description: 'Omit to change availability in every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty() @IsBoolean() isAvailable: boolean;
}

// ───────────── Modifiers (add-ons) ─────────────

export class ModifierInputDto {
  @ApiProperty({ example: 'Extra cheese' }) @IsString() @MinLength(1) @MaxLength(60) name: string;
  @ApiProperty({ example: '40.00' }) @Matches(MONEY, money('price')) price: string;
}

export class UpdateModifierDto extends PartialType(ModifierInputDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateModifierGroupDto {
  @ApiProperty({ example: 'Add-ons' }) @IsString() @MinLength(1) @MaxLength(60) name: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(20) minSelect?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(20) maxSelect?: number;

  @ApiPropertyOptional({ type: [ModifierInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ModifierInputDto)
  modifiers?: ModifierInputDto[];
}

export class UpdateModifierGroupDto extends PartialType(OmitType(CreateModifierGroupDto, ['modifiers'] as const)) {}

export class MenuQuery {
  @ApiProperty() @IsUUID() branchId: string;
}
