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
