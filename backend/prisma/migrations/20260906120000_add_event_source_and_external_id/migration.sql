-- AlterTable
ALTER TABLE "SymbolEvent" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'ADMIN_DEMO';

-- CreateIndex
CREATE UNIQUE INDEX "SymbolEvent_symbol_externalId_key" ON "SymbolEvent"("symbol", "externalId");

