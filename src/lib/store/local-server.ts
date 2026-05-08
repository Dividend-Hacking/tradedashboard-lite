/**
 * LocalServerStore — wraps the synchronous better-sqlite3 repos in
 * src/lib/local/repos.ts as the Store interface used by server
 * components, server actions, and route handlers.
 *
 * Realtime subscriptions throw — same reasoning as the Supabase
 * server store. Server contexts fetch once; client contexts handle
 * subscription via the local-client store.
 *
 * Tick blob URLs return a route under /api/local/replay-ticks signed
 * with a short-lived HMAC token (see signTickBlobPath in repos.ts).
 */

import type { Store } from "./index";
import {
  tradesRepo,
  replayRepo,
  practiceRepo,
  zonesRepo,
  liveRepo,
  orderRequestsRepo,
  traderPrefsRepo,
  presetsRepo,
  dashboardStateRepo,
  livebridgeEndpointRepo,
  signTickBlobPath,
} from "@/lib/local/repos";

const subscribeNotSupportedOnServer = (): never => {
  throw new Error(
    "Realtime subscriptions are not supported on the server. " +
      "Move this call into a client component."
  );
};

export function buildLocalServerStore(): Store {
  return {
    mode: "local",

    trades: {
      async listAllOrderedByEntryTime() {
        return tradesRepo.listAllOrderedByEntryTime();
      },
      async listForInstrumentSinceUtc(instrument, sinceIso) {
        return tradesRepo.listForInstrumentSinceUtc(instrument, sinceIso);
      },
      async deleteByIds(ids) {
        return tradesRepo.deleteByIds(ids);
      },
      async updateTags(id, patch) {
        tradesRepo.updateTags(id, patch);
      },
      async listBarsForTrade(tradeId) {
        return tradesRepo.listBarsForTrade(tradeId);
      },
      subscribeForInstrument: subscribeNotSupportedOnServer,
      subscribeAll: subscribeNotSupportedOnServer,
    },

    replay: {
      async listSessions() {
        return replayRepo.listSessions();
      },
      async getSession(id) {
        return replayRepo.getSession(id);
      },
      async updateLastBarIndex(sessionId, lastBarIndex) {
        replayRepo.updateLastBarIndex(sessionId, lastBarIndex);
      },
      async deleteSessions(ids) {
        return replayRepo.deleteSessions(ids);
      },
      async listBarsForSession(sessionId) {
        return replayRepo.listBarsForSession(sessionId);
      },
      async listBarsForSessions(sessionIds) {
        return replayRepo.listBarsForSessions(sessionIds);
      },
      async getTickBlobUrl(blobPath, expiresSec) {
        const token = signTickBlobPath(blobPath, expiresSec);
        return `/api/local/replay-ticks/${encodeURIComponent(blobPath)}?t=${token}`;
      },
      async listPendingDataRequests() {
        return replayRepo.listPendingDataRequests();
      },
      async findExistingSession(instrument, timeframe, sessionDate, granularity) {
        return replayRepo.findExistingSession(
          instrument,
          timeframe,
          sessionDate,
          granularity
        );
      },
      async findInFlightRequest(instrument, timeframe, sessionDate, granularity) {
        return replayRepo.findInFlightRequest(
          instrument,
          timeframe,
          sessionDate,
          granularity
        );
      },
      async insertDataRequest(req) {
        return replayRepo.insertDataRequest(req);
      },
      async insertDataRequestsBulk(reqs) {
        return replayRepo.insertDataRequestsBulk(reqs);
      },
      async deleteDataRequests(ids) {
        return replayRepo.deleteDataRequests(ids);
      },
      async listSessionsForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return replayRepo.listSessionsForBaseInWindow(
          base,
          timeframe,
          granularity,
          fromDate,
          toDate
        );
      },
      async listInFlightForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return replayRepo.listInFlightForBaseInWindow(
          base,
          timeframe,
          granularity,
          fromDate,
          toDate
        );
      },
      async listFailedForBaseInWindow(
        base,
        timeframe,
        granularity,
        fromDate,
        toDate,
        maxRetries
      ) {
        return replayRepo.listFailedForBaseInWindow(
          base,
          timeframe,
          granularity,
          fromDate,
          toDate,
          maxRetries
        );
      },
      async listNoDataForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return replayRepo.listNoDataForBaseInWindow(
          base,
          timeframe,
          granularity,
          fromDate,
          toDate
        );
      },
      async clearNoDataRequests() {
        return replayRepo.clearNoDataRequests();
      },
      async recoverStaleRequests(opts) {
        return replayRepo.recoverStaleRequests(opts);
      },
      async getQueueSummary() {
        return replayRepo.getQueueSummary();
      },
      async retryAllErrored() {
        return replayRepo.retryAllErrored();
      },
      subscribeDataRequests: subscribeNotSupportedOnServer,
      async listSessionsByInstrumentsAndTimeframes(instruments, timeframes) {
        return replayRepo.listSessionsByInstrumentsAndTimeframes(instruments, timeframes);
      },
      async listBarsForSessionInTimeRange(sessionId, fromIso, toIso) {
        return replayRepo.listBarsForSessionInTimeRange(sessionId, fromIso, toIso);
      },
    },

    practice: {
      async listSessions() {
        return practiceRepo.listSessions();
      },
      async getSession(id) {
        return practiceRepo.getSession(id);
      },
      async listTradesForSession(practiceSessionId) {
        return practiceRepo.listTradesForSession(practiceSessionId);
      },
      async saveSession(session, trades) {
        return practiceRepo.saveSession(session, trades);
      },
      async deleteSession(practiceSessionId) {
        practiceRepo.deleteSession(practiceSessionId);
      },
    },

    zones: {
      async listZones() {
        return zonesRepo.listZones();
      },
      async saveZone(zone, bars) {
        return zonesRepo.saveZone(zone, bars);
      },
      async deleteZones(ids) {
        return zonesRepo.deleteZones(ids);
      },
      async listBarsForZone(zoneId) {
        return zonesRepo.listBarsForZone(zoneId);
      },
      async listBarsForZones(zoneIds) {
        return zonesRepo.listBarsForZones(zoneIds);
      },
      async listSections() {
        return zonesRepo.listSections();
      },
      async createSection(name) {
        return zonesRepo.createSection(name);
      },
      async renameSection(id, name) {
        zonesRepo.renameSection(id, name);
      },
      async deleteSection(id) {
        zonesRepo.deleteSection(id);
      },
      async findSectionByName(name) {
        return zonesRepo.findSectionByName(name);
      },
      async reassignZonesToSection(fromId, toId) {
        zonesRepo.reassignZonesToSection(fromId, toId);
      },
      subscribeZones: subscribeNotSupportedOnServer,
      subscribeSections: subscribeNotSupportedOnServer,
      async listZonesInWindow(sectionId, instrument, fromIso, toIso) {
        return zonesRepo.listZonesInWindow(sectionId, instrument, fromIso, toIso);
      },
      async countZonesPerSectionInWindow(instrument, fromIso, toIso) {
        return zonesRepo.countZonesPerSectionInWindow(instrument, fromIso, toIso);
      },
    },

    live: {
      async listBarsForInstrument(instrument, timeframe, limit) {
        return liveRepo.listBarsForInstrument(instrument, timeframe, limit);
      },
      async deleteBarsForInstrument(instrument, timeframe) {
        liveRepo.deleteBarsForInstrument(instrument, timeframe);
      },
      async listStatesForInstrument(instrument) {
        return liveRepo.listStatesForInstrument(instrument);
      },
      async getTicker(instrument) {
        return liveRepo.getTicker(instrument);
      },
      async listAccounts() {
        return liveRepo.listAccounts();
      },
      async insertCommand(command) {
        liveRepo.insertCommand(command);
      },
      subscribeBars: subscribeNotSupportedOnServer,
      subscribeStates: subscribeNotSupportedOnServer,
      subscribeTicker: subscribeNotSupportedOnServer,
    },

    orderRequests: {
      async insert(row) {
        return orderRequestsRepo.insert(row);
      },
    },

    traderPrefs: {
      async fetch() {
        return traderPrefsRepo.fetch();
      },
      async upsertPatch(patch) {
        traderPrefsRepo.upsertPatch(patch);
      },
    },

    presets: {
      async list() {
        return presetsRepo.list();
      },
      async upsert(preset) {
        presetsRepo.upsert(preset);
      },
      async delete(id) {
        presetsRepo.delete(id);
      },
    },

    dashboardState: {
      async load() {
        return dashboardStateRepo.load();
      },
      async push(state, clientId) {
        dashboardStateRepo.push(state, clientId);
      },
      subscribe: subscribeNotSupportedOnServer,
    },

    livebridgeEndpoint: {
      async fetch() {
        return livebridgeEndpointRepo.fetch();
      },
      async upsert(row) {
        livebridgeEndpointRepo.upsert(row);
      },
    },
  };
}
