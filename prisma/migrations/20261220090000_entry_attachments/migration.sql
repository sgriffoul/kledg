CREATE TABLE "_EntryAttachments" (
    "A" TEXT NOT NULL REFERENCES "accounting_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "B" TEXT NOT NULL REFERENCES "attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_EntryAttachments_AB_pkey" PRIMARY KEY ("A", "B")
);
CREATE INDEX "_EntryAttachments_B_index" ON "_EntryAttachments"("B");
