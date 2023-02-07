import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as map from "lib0/map";

import * as debounce from "lodash.debounce";

import { callbackHandler, isCallbackSet } from "./callback";

import { MongodbPersistence } from "y-mongodb-provider";

import { createConnectionString } from "helpers/mongo";
// import { ywsAuthentication } from 'helpers/authentication';

const CALLBACK_DEBOUNCE_WAIT =
  parseInt(process.env.CALLBACK_DEBOUNCE_WAIT, 10) || 2000;
const CALLBACK_DEBOUNCE_MAXWAIT =
  parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT, 10) || 10000;

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

const DEBUG_LOGS = true;
const USE_AUTH = false;

const pingTimeout = 30000;

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== "false" && process.env.GC !== "0";

/*
 * PERSISTENCE
 */
const mdb = new MongodbPersistence(createConnectionString("yjstest"), {
  collectionName: "transactions",
  flushSize: 100,
  multipleCollections: true,
});

let persistence = null;
export const setPersistence = () => {
  /*
   Persistence must have the following signature:
  { bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise }
  */
  persistence = {
    bindState: async (docName, ydoc) => {
      const persistedYdoc = await mdb.getYDoc(docName);
      // get the state vector so we can just store the diffs between client and server
      const persistedStateVector = Y.encodeStateVector(persistedYdoc);
      const diff = Y.encodeStateAsUpdate(ydoc, persistedStateVector);

      // store the new data in db (if there is any: empty update is an array of 0s)
      if (
        diff.reduce(
          (previousValue, currentValue) => previousValue + currentValue,
          0
        ) > 0
      )
        mdb.storeUpdate(docName, diff);

      // send the persisted data to clients
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));

      // store updates of the document in db
      ydoc.on("update", async (update) => {
        if (DEBUG_LOGS) console.debug("update", docName);
        mdb.storeUpdate(docName, update);
      });

      // detect subdoc deletions and remove them from db as well
      const subdocFolder = ydoc.getMap();
      subdocFolder.observe((yMapEvent) => {
        if (yMapEvent.target !== subdocFolder) return;

        yMapEvent.changes.keys.forEach((change, key) => {
          if (change.action === "delete") {
            if (DEBUG_LOGS) console.debug("delete subdoc from mdb", key);
            mdb.clearDocument(key);
          }
        });
      });

      // cleanup some memory
      persistedYdoc.destroy();
    },
    writeState: async (docName /* , ydoc */) => {
      if (DEBUG_LOGS) console.debug("document closed", docName);
    },
  };
};
/**
 * @type {Map<string,WSSharedDoc>}
 */
// exporting docs so that others can use it
export const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;
const messageAuth = 2;

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    /**
     * @type {Set<number>}
     */
    // @ts-ignore
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );
    if (doc.conns.size === 0) {
      doc.destroy();
      docs.delete(doc.name);
    }
  }
  conn.close();
};

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    closeConn(doc, conn);
  }
  try {
    conn.send(
      m,
      /** @param {any} err */ (err) => {
        if (err != null) closeConn(doc, conn);
      }
    );
  } catch (e) {
    closeConn(doc, conn);
  }
};

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  encoding.writeVarString(encoder, doc.name);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};
class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor(name) {
    super({ gc: gcEnabled });
    this.name = name;
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map();
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs = /** @type {Set<number>} */ (
          this.conns.get(conn)
        );
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => {
            connControlledIDs.add(clientID);
          });
          removed.forEach((clientID) => {
            connControlledIDs.delete(clientID);
          });
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on("update", awarenessChangeHandler);
    this.on("update", updateHandler);

    if (isCallbackSet) {
      this.on(
        "update",
        debounce(callbackHandler, CALLBACK_DEBOUNCE_WAIT, {
          maxWait: CALLBACK_DEBOUNCE_MAXWAIT,
        })
      );
    }

    this.loadedSubdocs = {};
    this.loadSubdoc = (subdocId) => {
      // if (this.loadedSubdocs[subdocId]) {
      // 	return this.loadedSubdocs[subdocId];
      // }
      console.log("loadSubdoc", subdocId);
      const subdoc = getYDoc(subdocId, true, true);
      this.loadedSubdocs[subdocId] = subdoc;
      return subdoc;
    };

    this.destroy = () => {
      console.log("destroy ydoc", this.name);
      // if persisted, we store state and destroy ydocument
      if (persistence !== null) {
        persistence.writeState(this.name, this).then(() => {
          for (const subdoc of Object.values(this.loadedSubdocs)) {
            subdoc.destroy();
          }
          super.destroy();
        });
      } else {
        for (const subdoc of Object.values(this.loadedSubdocs)) {
          subdoc.destroy();
        }
        super.destroy();
      }
    };
  }
}

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
export const getYDoc = (docname, gc = true, isSubdoc = false) =>
  map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname, isSubdoc);
    doc.gc = gc;
    if (persistence !== null) {
      persistence.bindState(docname, doc);
    }
    docs.set(docname, doc);
    return doc;
  });

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const _onMessage = async (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageAuth: {
        const authenticationToken = decoding.readVarString(decoder);
        const [mainDiagramId, token] = authenticationToken.split(",");
        const docName = doc.name;
        if (DEBUG_LOGS)
          console.debug("authenticate", { mainDiagramId, docName, token });

        if (USE_AUTH) {
          // conn.authenticated = await ywsAuthentication(docName, token);
          if (DEBUG_LOGS) console.debug("authenticated?", conn.authenticated);
        } else {
          conn.authenticated = true;
        }

        if (conn.authenticated) {
          // inform client that he's authenticated
          const authEncoder = encoding.createEncoder();
          encoding.writeVarUint(authEncoder, messageAuth);
          encoding.writeAny(authEncoder, true);
          send(doc, conn, encoding.toUint8Array(authEncoder));

          // setup the normal y-websocket connection

          // send sync step 1
          {
            const syncEncoder = encoding.createEncoder();
            encoding.writeVarUint(syncEncoder, messageSync);
            encoding.writeVarString(syncEncoder, doc.name);
            syncProtocol.writeSyncStep1(syncEncoder, doc);
            send(doc, conn, encoding.toUint8Array(syncEncoder));
            const awarenessStates = doc.awareness.getStates();
            if (awarenessStates.size > 0) {
              const awarenessEncoder = encoding.createEncoder();
              encoding.writeVarUint(awarenessEncoder, messageAwareness);
              encoding.writeVarUint8Array(
                awarenessEncoder,
                awarenessProtocol.encodeAwarenessUpdate(
                  doc.awareness,
                  Array.from(awarenessStates.keys())
                )
              );
              send(doc, conn, encoding.toUint8Array(awarenessEncoder));
            }
          }
        } else {
          // inform client that he is not authenticated
          const authEncoder = encoding.createEncoder();
          encoding.writeVarUint(authEncoder, messageAuth);
          encoding.writeAny(authEncoder, false);
          send(doc, conn, encoding.toUint8Array(authEncoder));

          // close connection
          closeConn(doc, conn);
        }
        break;
      }
      case messageAwareness: {
        if (!conn.authenticated) {
          conn.preauthenticatedMessages.push(message);
          break;
        }

        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
      case messageSync: {
        if (!conn.authenticated) {
          conn.preauthenticatedMessages.push(message);
          break;
        }
        // get docId
        const docId = decoding.readVarString(decoder);
        encoding.writeVarUint(encoder, messageSync);
        encoding.writeVarString(encoder, docId);
        // check that there is still sth interesting in the message
        if (!decoding.hasContent(decoder)) break;

        // load different docs, depending on id
        if (doc.name === docId) {
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
        } else {
          const subdoc = doc.loadSubdoc(docId);
          // now that we have the subdoc, the sync process becomes identical to the standard case.
          syncProtocol.readSyncMessage(decoder, encoder, subdoc, null);
        }
        // If the `encoder` only contains the type of reply message & subdocId and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 38
        if (encoding.length(encoder) > 38) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      }
      default: {
        console.warn(
          "_onMessage triggered with undefined messageType",
          messageType
        );
      }
    }
  } catch (err) {
    console.error(err);
  }
};

export const setupWSConnection = (
  conn,
  req,
  { docName = req.url.slice(8).split("?")[0], gc = true } = {}
) => {
  conn.binaryType = "arraybuffer";
  // get doc, initialize if it does not exist yet
  const doc = getYDoc(docName, gc);
  if (DEBUG_LOGS) console.debug("setupWSConnection", docName, !!doc);
  doc.conns.set(conn, new Set());
  conn.preauthenticatedMessages = [];

  conn.on("message", (data) => {
    if (conn.authenticated) {
      const preauthenticatedMessages = [...conn.preauthenticatedMessages];
      conn.preauthenticatedMessages = [];
      for (const preauthenticatedMessage of preauthenticatedMessages) {
        _onMessage(conn, doc, preauthenticatedMessage);
      }
    }
    _onMessage(conn, doc, new Uint8Array(data));
  });

  // Check if connection is still alive
  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn);
      }
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch (e) {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);
  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });
  conn.on("pong", () => {
    pongReceived = true;
  });
};
