ALTER TABLE "attachments" ADD COLUMN "supplierId" TEXT REFERENCES "tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "attachments_supplierId_idx" ON "attachments"("supplierId");
