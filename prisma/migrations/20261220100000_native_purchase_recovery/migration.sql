ALTER TABLE "invoices" ADD COLUMN "purchaseOriginal" JSONB;
ALTER TABLE "invoices" ADD CONSTRAINT "purchase_original_direction" CHECK ("purchaseOriginal" IS NULL OR direction = 'PURCHASE');
ALTER TABLE "entry_lines" ADD COLUMN "settlementBankId" TEXT REFERENCES "bank_transactions"(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX "entry_lines_settlementBankId_key" ON "entry_lines"("settlementBankId");
-- A gross-only supplier receipt has no known tax base or tax amount.
ALTER TABLE invoices ADD COLUMN "unitemizedAmount" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices DROP CONSTRAINT invoices_amounts_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_check CHECK (
  "totalExclTax" >= 0 AND "totalVat" >= 0 AND "totalInclTax" = "totalExclTax" + "totalVat" + "unitemizedAmount"
  AND ("unitemizedAmount" = 0 OR (direction = 'PURCHASE' AND "unitemizedAmount" > 0
       AND "totalExclTax" = 0 AND "totalVat" = 0 AND "purchaseOriginal" IS NOT NULL
       AND "purchaseOriginal" @> '{"net":null}'::jsonb))
);
