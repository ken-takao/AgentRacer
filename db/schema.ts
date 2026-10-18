import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const races = sqliteTable("races", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  version: integer("version").notNull().default(0),
  state: text("state").notNull(),
  redHash: text("red_hash").notNull(),
  blueHash: text("blue_hash").notNull(),
});
export const raceTelemetry = sqliteTable("race_telemetry", {
  id: text("id").primaryKey(),
  raceId: text("race_id").notNull(),
  player: text("player").notNull(),
  status: text("status").notNull().default("待機中"),
  sessionId: text("session_id"),
  actions: integer("actions").notNull().default(0),
  frameAt: integer("frame_at"),
});
