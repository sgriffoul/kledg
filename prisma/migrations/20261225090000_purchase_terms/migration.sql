ALTER TABLE invoices ADD COLUMN "purchaseTerms" JSONB,
  ADD CONSTRAINT purchase_terms_direction CHECK ("purchaseTerms" IS NULL OR direction = 'PURCHASE');
