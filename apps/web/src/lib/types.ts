/** Shapes returned by the API (money and quantities are decimal strings). */

export interface Me {
  user: { id: string; email: string; fullName: string; phone: string | null; lastLoginAt: string | null };
  organization: { id: string; name: string; gstin: string | null; stateCode: string | null };
  roles: { roleId: string; roleKey: string; branchId: string | null }[];
  permissions: { organizationWide: string[]; byBranch: Record<string, string[]> };
  branches: Branch[];
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  stateCode: string;
}

export interface MenuCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface MenuModifier {
  id: string;
  name: string;
  price: string;
}

export interface MenuProduct {
  id: string;
  categoryId: string;
  sku: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  isVeg: boolean;
  isCombo: boolean;
  stationCode: string | null;
  price: string;
  isAvailable: boolean;
  taxRate: { rate: string };
  variants: { id: string; name: string; isDefault: boolean; price: string; isAvailable: boolean }[];
  modifierGroups: { id: string; name: string; minSelect: number; maxSelect: number; modifiers: MenuModifier[] }[];
}

export interface PosMenu {
  branchId: string;
  taxPricingMode: 'EXCLUSIVE' | 'INCLUSIVE';
  categories: MenuCategory[];
  products: MenuProduct[];
}

export type OrderStatus = 'NEW' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'SERVED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'PICKED_UP' | 'COMPLETED' | 'CANCELLED';
export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
export type KitchenStatus = 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'WALLET' | 'BANK_TRANSFER' | 'OTHER';

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: string;
  unitPrice: string;
  modifiersTotal: string;
  lineSubtotal: string;
  discountAmount: string;
  taxAmount: string;
  lineTotal: string;
  specialInstructions: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  kitchenStatus: KitchenStatus;
  modifiers: { id: string; name: string; price: string; quantity: number }[];
  ticketItems: { id: string }[];
}

export interface Order {
  id: string;
  branchId: string;
  orderNumber: string;
  orderType: OrderType;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  subtotal: string;
  discountTotal: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  grandTotal: string;
  paymentStatus: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  appliedDiscounts: { id: string; scope: string; type: string; value: string; amount: string; reason: string | null }[];
  kitchenTickets: { id: string; ticketNumber: string; status: string }[];
  invoices: { id: string; invoiceNumber: string; status: string; paymentStatus?: string }[];
  tableSession: { id: string; tableId: string; table: { label: string } } | null;
  allowedTransitions: OrderStatus[];
}

export interface TableRow {
  id: string;
  label: string;
  area: string | null;
  capacity: number;
  status: 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'BILL_PENDING' | 'OUT_OF_SERVICE';
  shape: 'RECT' | 'ROUND' | string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  reservationName: string | null;
  reservedUntil: string | null;
  version: number;
  isActive?: boolean;
  session: { id: string; guestCount: number | null; openedAt: string; mergedIntoTableId: string | null; mergedTableIds: string[] } | null;
}

export interface Ticket {
  id: string;
  ticketNumber: string;
  status: KitchenStatus;
  station: { id: string; code: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  elapsedSeconds: number;
  order: { id: string; orderNumber: string; orderType: OrderType; status: OrderStatus; table: { id: string; label: string } | null; customerName: string | null; guestCount: number | null; notes: string | null };
  items: { id: string; orderItemId: string; productName: string; variantName: string | null; quantity: string; instructions: string | null; modifiers: string[]; status: KitchenStatus }[];
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  amount: string;
  allocated?: string;
  reference: string | null;
  status: string;
  receivedAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: 'FINALIZED' | 'CANCELLED';
  orderId: string;
  subtotal: string;
  discountTotal: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  grandTotal: string;
  paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | string;
  outstanding: string;
  netPaid: string;
  refundDue: string;
  payments: Payment[];
  items: { id: string; lineNo: number; description: string; quantity: string; unitPrice: string; lineTotal: string }[];
  order: { id: string; orderNumber: string; orderType: OrderType; status: OrderStatus; tableSession: { table: { label: string } } | null };
}

export interface CashSession {
  id: string;
  status: 'OPEN' | 'CLOSED';
  openingBalance: string;
  expectedCash: string;
  openedAt: string;
  user: { id: string; fullName: string };
}

/** Admin view of a dish (`/menu/products`). */
export interface AdminProduct {
  id: string;
  categoryId: string;
  taxRateId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  basePrice: string;
  hsnSac: string | null;
  isVeg: boolean;
  stationCode: string | null;
  isCombo: boolean;
  isActive: boolean;
  isAvailable: boolean;
  sortOrder: number;
  category: { id: string; name: string };
  variants: { id: string; name: string; price: string; isDefault: boolean; isActive: boolean; sortOrder: number }[];
  /** Present on the single-dish read. */
  modifierGroups?: { groupId: string; group: { id: string; name: string } }[];
}

export interface AdminCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  _count: { products: number };
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: { id: string; name: string; price: string; isActive: boolean }[];
}

export interface TaxRate {
  id: string;
  name: string;
  rate: string;
  isActive: boolean;
}

export interface KitchenStation {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface StaffUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  roles: { assignmentId: string; roleId: string; roleKey: string; roleName: string; branchId: string | null }[];
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export interface Unit {
  id: string;
  code: string;
  name: string;
  dimension: 'MASS' | 'VOLUME' | 'COUNT';
  factorToBase: string;
}

export interface Ingredient {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  isActive: boolean;
  baseUnit: Unit;
}

/** One ingredient's stock in a branch. Quantities are in the ingredient's base unit (g, ml or pc). */
export interface StockRow {
  ingredientId: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  quantity: string;
  minimumLevel: string;
  averageCost: string;
  stockValue: string;
  isLow: boolean;
  isNegative: boolean;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  ingredientId: string;
  ingredientName: string;
  type: string;
  quantity: string;
  unit: string;
  unitCost: string;
  value: string;
  balanceAfter: string;
  note: string | null;
  referenceType: string | null;
  createdAt: string;
}

export interface RecipeLine {
  ingredientId: string;
  ingredientName: string;
  quantity: string;
  unit: string;
  wastagePercent: string;
  perPortion: string;
  baseUnit: string;
  estimatedCost?: string;
}

export interface Recipe {
  id: string;
  productId: string;
  productName: string;
  variantId: string | null;
  yieldQuantity: string;
  items: RecipeLine[];
  estimatedCostPerPortion?: string;
  updatedAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
  paymentTermsDays: number | null;
  isActive: boolean;
}

export type PurchaseOrderStatus = 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderItem {
  id: string;
  ingredientId: string;
  quantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  ingredient: { id: string; name: string };
  unit: { code: string };
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  notes: string | null;
  cancelReason: string | null;
  createdById: string;
  supplier: { id: string; name: string; gstin: string | null };
  items: PurchaseOrderItem[];
}

export interface GoodsReceipt {
  id: string;
  grnNumber: string;
  receivedAt: string;
  notes: string | null;
  supplier: { id: string; name: string };
  purchaseOrder: { id: string; poNumber: string } | null;
  items: { id: string; quantity: string; unitPrice: string; ingredient: { id: string; name: string }; unit: { code: string } }[];
  totalValue: string;
}

export interface CashShift {
  id: string;
  branchId: string;
  userId: string;
  terminal: string | null;
  status: 'OPEN' | 'CLOSED';
  openingBalance: string;
  openedAt: string;
  expectedCash: string;
  actualCash: string | null;
  discrepancy: string | null;
  closingNotes: string | null;
  closedAt: string | null;
  user: { id: string; fullName: string; email: string };
}

export interface ShiftReport {
  id: string;
  branchId: string;
  cashier: { id: string; fullName: string };
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  closedBy: { id: string; fullName: string } | null;
  cash: { openingFloat: string; cashSales: string; cashRefunds: string; cashIn: string; cashOut: string; expenses: string; expected: string; actual: string | null; discrepancy: string | null; notes: string | null };
  paymentsByMethod: { method: string; count: number; amount: string }[];
  refundsByMethod: { method: string; count: number; amount: string }[];
  totalCollected: string;
  movements: { id: string; type: string; amount: string; note: string | null; createdAt: string }[];
}


export interface ExpenseCategory {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Expense {
  id: string;
  branchId: string;
  categoryId: string;
  amount: string;
  taxAmount: string;
  description: string;
  expenseDate: string;
  paymentMethod: PaymentMethod;
  paidTo: string | null;
  employeeId: string | null;
  receiptUrl: string | null;
  cashSessionId: string | null;
  createdById: string;
  deletedAt: string | null;
  deleteReason: string | null;
  category: { id: string; name: string };
  employee: { id: string; fullName: string } | null;
}

export interface ExpenseSummary {
  from: string;
  to: string;
  count: number;
  total: string;
  taxTotal: string;
  byCategory: { categoryId: string; name: string; count: number; amount: string }[];
  byPaymentMethod: { method: string; count: number; amount: string }[];
}

export interface SupplierBill {
  id: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidAmount: string;
  outstanding: string;
  isOverdue: boolean;
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
  supplier: { id: string; name: string };
  payments?: { id: string; amount: string; method: PaymentMethod; reference: string | null; paidAt?: string; createdAt: string }[];
  goodsReceipts?: { id: string; grnNumber: string; receivedAt: string }[];
}

export interface Employee {
  id: string;
  userId: string | null;
  primaryBranchId: string | null;
  employeeCode: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  designation: string | null;
  joiningDate: string | null;
  /** Only sent to people allowed to see pay. */
  monthlySalary?: string | null;
  isActive: boolean;
  primaryBranch?: { id: string; name: string } | null;
  user?: { id: string; email: string; isActive: boolean; userRoles: { branchId: string | null; role: { key: string; name: string } }[] } | null;
}

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LEAVE';

export interface AttendanceRow {
  id: string;
  branchId: string;
  employeeId: string;
  workDate: string;
  status: AttendanceStatus;
  clockInAt: string | null;
  clockOutAt: string | null;
  notes: string | null;
  hoursWorked: string;
  employee?: { id: string; fullName: string; employeeCode: string };
}
