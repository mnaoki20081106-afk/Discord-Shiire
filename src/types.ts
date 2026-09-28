export interface Env {
  DB: D1Database;
  MAIN_BOT_BASE_URL?: string;
  XACCOUNT_BOT_BASE_URL?: string;
  ADMIN_TOKEN: string;
  SHIIRE_BRIDGE_SECRET: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;

  // X account procurement integrations. All of these are Worker Secrets.
  BINANCE_API_KEY?: string;
  BINANCE_API_SECRET?: string;
  BINANCE_WITHDRAW_API_KEY?: string;
  BINANCE_WITHDRAW_API_SECRET?: string;
  BINANCE_TRAVEL_RULE_QUESTIONNAIRE?: string;
  BINANCE_FIXED_EGRESS_CONFIRMED?: string;
  HSTORA_API_KEY?: string;
  HSTORA_API_SECRET?: string;
  HSTORA_WEBHOOK_SECRET?: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
  DISCORD_NOTIFY_WEBHOOK_URL?: string;
}

export type SupplierKind = "pool" | "http_json";
export type ProcessorKind = "identity" | "http_json";

export type SupplierRow = {
  id:string;
  name:string;
  kind:SupplierKind;
  config_json:string;
  enabled:number;
  created_at:number;
  updated_at:number;
};

export type ProductRow = {
  id:string;
  name:string;
  supplier_id:string;
  supplier_sku:string;
  main_product_id:string;
  min_stock:number;
  target_stock:number;
  max_batch:number;
  processor_kind:ProcessorKind;
  processor_config_json:string;
  enabled:number;
  created_at:number;
  updated_at:number;
};

export type JobStatus =
  | "acquiring"
  | "acquisition_failed"
  | "acquired"
  | "processing_failed"
  | "delivery_failed"
  | "out_of_stock"
  | "delivered"
  | "failed";

export type JobRow = {
  id:string;
  product_id:string;
  status:JobStatus;
  requested_qty:number;
  acquired_qty:number;
  delivered_qty:number;
  attempt_count:number;
  next_retry_at:number|null;
  error:string|null;
  created_at:number;
  updated_at:number;
};
