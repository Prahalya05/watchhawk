-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('PRICE_MOVE', 'VOLUME_SPIKE', 'FIFTY_TWO_WEEK_EXTREME', 'GAP_OPEN', 'NEWS', 'RATING_CHANGE', 'CORPORATE_ACTION');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('MINOR', 'NOTABLE', 'CRITICAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSymbolState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenPrice" DOUBLE PRECISION NOT NULL,
    "lastSeenVolume" DOUBLE PRECISION NOT NULL,
    "lastSeen52wHigh" DOUBLE PRECISION NOT NULL,
    "lastSeen52wLow" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSymbolState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolEvent" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "severity" "Severity" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymbolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolStats" (
    "symbol" TEXT NOT NULL,
    "avgVolume20d" DOUBLE PRECISION NOT NULL,
    "stdevReturn20d" DOUBLE PRECISION NOT NULL,
    "high52w" DOUBLE PRECISION NOT NULL,
    "low52w" DOUBLE PRECISION NOT NULL,
    "avgOvernightGapPct" DOUBLE PRECISION NOT NULL,
    "historyDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymbolStats_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "WatchlistItem_userId_idx" ON "WatchlistItem"("userId");

-- CreateIndex
CREATE INDEX "WatchlistItem_symbol_idx" ON "WatchlistItem"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_symbol_key" ON "WatchlistItem"("userId", "symbol");

-- CreateIndex
CREATE INDEX "UserSymbolState_symbol_idx" ON "UserSymbolState"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "UserSymbolState_userId_symbol_key" ON "UserSymbolState"("userId", "symbol");

-- CreateIndex
CREATE INDEX "SymbolEvent_symbol_eventTime_idx" ON "SymbolEvent"("symbol", "eventTime");

-- CreateIndex
CREATE INDEX "SymbolEvent_symbol_eventType_eventTime_idx" ON "SymbolEvent"("symbol", "eventType", "eventTime");

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSymbolState" ADD CONSTRAINT "UserSymbolState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
