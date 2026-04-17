export { checkDatabaseConnectivity } from "./health.js";
export {
  insertProduct,
  findProductById,
  findProductBySlug,
  findAllProducts,
  updateProduct,
  isValidProductTransition,
  insertProductMedia,
  findMediaByProductId,
  findMediaById,
  updateProductMedia,
  deleteProductMedia,
  reorderProductMedia,
  insertCollection,
  findCollectionById,
  findAllCollections,
  updateCollection,
  addProductToCollection,
  removeProductFromCollection,
  findProductsByCollectionId,
} from "./product.js";
export type {
  NewProduct,
  Product,
  NewProductMedia,
  ProductMedia,
  NewCollection,
  Collection,
  NewCollectionProduct,
  CollectionProduct,
} from "./product.js";
export { insertAuditLog, findAuditLogsByEntityId } from "./audit-log.js";
export type { AuditLogEntry, AuditLogRecord } from "./audit-log.js";
export { linkGuestOrdersByEmail, findOrdersByCustomerId } from "./order.js";
export {
  insertVariant,
  findVariantById,
  findVariantsByProductId,
  updateVariant,
  isValidVariantTransition,
} from "./variant.js";
export type { NewProductVariant, ProductVariant } from "./variant.js";
export {
  insertProductClass,
  findProductClassById,
  findProductClassBySlug,
  listProductClasses,
  updateProductClass,
  deleteProductClass,
  assignProductToClass,
  removeProductFromClass,
  findMembershipsByProductId,
} from "./product-class.js";
export type { NewProductClass, ProductClass, ProductClassMembership } from "./product-class.js";
export {
  findInventoryBalances,
  findBalanceByVariantAndLocation,
  createInventoryAdjustment,
  findLocationByCode,
  insertInventoryLocation,
} from "./inventory.js";
export type {
  InventoryBalance,
  InventoryAdjustment,
  InventoryMovement,
  BalanceFilters,
  CreateAdjustmentInput,
  AdjustmentResult,
} from "./inventory.js";
export {
  reserveInventory,
  consumeReservation,
  releaseReservation,
  releaseExpiredReservations,
  findReservationById,
  isValidReservationTransition,
} from "./reservation.js";
export type {
  InventoryReservation,
  ReserveInput,
  ReserveResult,
  ConsumeResult,
  ReleaseResult,
} from "./reservation.js";
export { findActiveProductsWithDetails, findActiveProductBySlug } from "./catalog.js";
export type { CatalogProduct, CatalogVariant, CatalogMedia } from "./catalog.js";
export {
  insertAddress,
  findAddressesByCustomerId,
  findAddressById,
  updateAddress,
  deleteAddress,
  validateAddressFields,
} from "./address.js";
export type { NewCustomerAddress, CustomerAddress } from "./address.js";
export {
  createCart,
  findCartByToken,
  findActiveCartByCustomerId,
  addCartItem,
  removeCartItem,
  getCartWithItems,
} from "./cart.js";
export type { Cart, CartLine, CartLineWithDetails, CartWithItems } from "./cart.js";
