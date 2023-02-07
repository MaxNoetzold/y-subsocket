/**
 * @module provider/websocket
 */

/* eslint-env browser */

import * as Y from "yjs"; // eslint-disable-line
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as bc from "lib0/broadcastchannel";
import * as time from "lib0/time";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import * as math from "lib0/math";
import * as url from "lib0/url";

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;

/**
 *                       encoder,          decoder,          provider,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketProvider, boolean,    number):void>}
 */
const messageHandlers = [];

messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  messageType
) => {
  const docId = decoding.readVarString(decoder);
  encoding.writeVarUint(encoder, messageSync);
  encoding.writeVarString(encoder, docId);
  let doc = provider.doc;
  if (provider.roomname !== docId) {
    doc = provider.getSubDoc(docId);
  }
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    doc,
    provider
  );
  if (emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2) {
    doc.emit("synced", [true]);
  }
};

messageHandlers[messageQueryAwareness] = (
  encoder,
  _decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(
      provider.awareness,
      Array.from(provider.awareness.getStates().keys())
    )
  );
};

messageHandlers[messageAwareness] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  awarenessProtocol.applyAwarenessUpdate(
    provider.awareness,
    decoding.readVarUint8Array(decoder),
    provider
  );
};

messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  provider.authenticated = decoding.readAny(decoder);
  if (provider.authenticated) {
    provider.emit("status", [
      {
        status: "authenticated",
      },
    ]);
    // always send sync step 1 when authenticated
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    encoding.writeVarString(encoder, provider.roomname);
    syncProtocol.writeSyncStep1(encoder, provider.doc);
    provider.ws.send(encoding.toUint8Array(encoder));
    // broadcast local awareness state
    if (provider.awareness.getLocalState() !== null) {
      const encoderAwarenessState = encoding.createEncoder();
      encoding.writeVarUint(encoderAwarenessState, messageAwareness);
      encoding.writeVarUint8Array(
        encoderAwarenessState,
        awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
          provider.doc.clientID,
        ])
      );
      provider.ws.send(encoding.toUint8Array(encoderAwarenessState));
    }
  } else {
    provider.emit("status", [
      {
        status: "access-denied",
      },
    ]);
    provider.disconnect();
  }
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

/**
 * @param {WebsocketProvider} provider
 * @param {Uint8Array} buf
 * @param {boolean} emitSynced
 * @return {encoding.Encoder}
 */
const readMessage = (provider, buf, emitSynced) => {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  const messageHandler = provider.messageHandlers[messageType];
  if (/** @type {any} */ (messageHandler)) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType);
  } else {
    console.error("Unable to compute message");
  }
  return encoder;
};

/**
 * @param {WebsocketProvider} provider
 */
const setupWS = (provider) => {
  if (provider.shouldConnect && provider.ws === null) {
    const websocket = new provider._WS(provider.url);
    websocket.binaryType = "arraybuffer";
    provider.ws = websocket;
    provider.wsconnecting = true;
    provider.wsconnected = false;
    provider.synced = false;

    websocket.onmessage = (event) => {
      try {
        provider.wsLastMessageReceived = time.getUnixTime();
        const encoder = readMessage(provider, new Uint8Array(event.data), true);
        if (encoding.length(encoder) > 1) {
          websocket.send(encoding.toUint8Array(encoder));
        }
      } catch (error) {
        // probably this error: https://github.com/yjs/y-protocols/issues/19
        console.error("websocket.onmessage", provider.roomname, error);
        provider.emit("#19-error", [error, provider]);
      }
    };
    websocket.onerror = (event) => {
      provider.emit("connection-error", [event, provider]);
    };
    websocket.onclose = (event) => {
      provider.emit("connection-close", [event, provider]);
      provider.ws = null;
      provider.wsconnecting = false;
      if (provider.wsconnected) {
        provider.wsconnected = false;
        provider.synced = false;
        // update awareness (all users except local left)
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter(
            (client) => client !== provider.doc.clientID
          ),
          provider
        );
        provider.emit("status", [
          {
            status: "disconnected",
          },
        ]);
      } else {
        provider.wsUnsuccessfulReconnects++;
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      );
    };
    websocket.onopen = () => {
      provider.wsLastMessageReceived = time.getUnixTime();
      provider.wsconnecting = false;
      provider.wsconnected = true;
      provider.wsUnsuccessfulReconnects = 0;
      provider.emit("status", [
        {
          status: "connected",
        },
      ]);
      // always send token in step one to check if we are authenticated
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAuth);
      encoding.writeVarString(encoder, provider.userToken);
      websocket.send(encoding.toUint8Array(encoder));
    };

    provider.emit("status", [
      {
        status: "connecting",
      },
    ]);
  }
};

/**
 * @param {WebsocketProvider} provider
 * @param {ArrayBuffer} buf
 */
const broadcastMessage = (provider, buf) => {
  if (provider.wsconnected) {
    /** @type {WebSocket} */ (provider.ws).send(buf);
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider);
  }
};

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebsocketProvider } from 'y-websocket'
 *   const doc = new Y.Doc()
 *   const provider = new WebsocketProvider('http://localhost:1234', 'my-document-name', doc)
 *
 * @extends {Observable<string>}
 */
export class WebsocketProvider extends Observable {
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {object} [opts]
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string,string>} [opts.params]
   * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
   * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
   * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
   * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
   * @param {string} [opts.userToken] access token to authenticate at connection
   */
  constructor(
    serverUrl,
    roomname,
    doc,
    {
      connect = true,
      awareness = new awarenessProtocol.Awareness(doc),
      params = {},
      WebSocketPolyfill = WebSocket,
      resyncInterval = -1,
      maxBackoffTime = 2500,
      disableBc = false,
      userToken,
    } = {}
  ) {
    super();
    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    const encodedParams = url.encodeQueryParams(params);
    this.maxBackoffTime = maxBackoffTime;
    this.bcChannel = serverUrl + "/" + roomname;
    this.url =
      serverUrl +
      "/" +
      roomname +
      (encodedParams.length === 0 ? "" : "?" + encodedParams);
    this.roomname = roomname;
    this.doc = doc;
    this._WS = WebSocketPolyfill;
    this.awareness = awareness;
    this.wsconnected = false;
    this.wsconnecting = false;
    this.bcconnected = false;
    this.disableBc = disableBc;
    this.wsUnsuccessfulReconnects = 0;
    this.messageHandlers = messageHandlers.slice();
    this.authenticated = false;
    this.userToken = userToken;
    /**
     * @type {boolean}
     */
    this._synced = false;
    /**
     * @type {WebSocket?}
     */
    this.ws = null;
    this.wsLastMessageReceived = 0;
    /**
     * Whether to connect to other peers or not
     * @type {boolean}
     */
    this.shouldConnect = connect;
    /**
     * @type {Map<string, Y.Doc>}
     */
    this.subdocs = new Map();

    /**
     * @type {number}
     */
    this._resyncInterval = 0;
    if (resyncInterval > 0) {
      this._resyncInterval = /** @type {any} */ (
        setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // resend sync step 1 for maindoc
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            encoding.writeVarString(encoder, this.roomname);
            syncProtocol.writeSyncStep1(encoder, doc);
            this.ws.send(encoding.toUint8Array(encoder));
          }
        }, resyncInterval)
      );
    }

    /**
     * @param {ArrayBuffer} data
     * @param {any} origin
     */
    this._bcSubscriber = (data, origin) => {
      if (origin !== this) {
        const encoder = readMessage(this, new Uint8Array(data), false);
        if (encoding.length(encoder) > 1) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this);
        }
      }
    };
    /**
     * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        encoding.writeVarString(encoder, this.roomname);
        syncProtocol.writeUpdate(encoder, update);
        broadcastMessage(this, encoding.toUint8Array(encoder));
      }
    };
    this.doc.on("update", this._updateHandler);

    /**
     * When dealing with subdocs, it is possible to race the websocket connection
     * where we are ready to load subdocuments but the connection is not yet ready to send
     * This function is just a quick and dirty retry function for when we can't be sure
     * if the connection is present
     * @param {any} message
     * @param {Function} callback
     */
    this.send = function (message, callback) {
      const ws = this.ws;
      this.waitForConnection(function () {
        // @ts-ignore
        ws.send(message);
        if (typeof callback !== "undefined") {
          callback();
        }
      }, 1000);
    };
    /**
     *
     * @param {Function} callback
     * @param {Number} interval
     */
    this.waitForConnection = function (callback, interval) {
      const ws = this.ws;
      if (ws && ws.readyState === 1) {
        callback();
      } else {
        var that = this;
        // optional: implement backoff for interval here
        setTimeout(function () {
          that.waitForConnection(callback, interval);
        }, interval);
      }
    };

    this._getSubDocUpdateHandler = (id) => {
      /**
       *
       * @param {Uint8Array} update
       * @param {WebsocketProvider} origin
       */
      const updateHandler = (update, origin) => {
        console.log("subdoc update", id);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        encoding.writeVarString(encoder, id);
        syncProtocol.writeUpdate(encoder, update);
        broadcastMessage(this, encoding.toUint8Array(encoder));
      };
      return updateHandler;
    };

    // TODO: .off() on destroy()
    /**
     * Watch for subdoc events and reconcile local state
     */
    this.doc.on("subdocs", ({ added, removed, loaded }) => {
      console.log("y-subsocket onSubdocs", { added, removed, loaded });
      added.forEach((subdoc) => {
        this.subdocs.set(subdoc.guid, subdoc);
      });
      removed.forEach((subdoc) => {
        // subdoc.off('update', this._getSubDocUpdateHandler(subdoc.guid));
        // this.subdocs.delete(subdoc.guid);
      });
      loaded.forEach((subdoc) => {
        if (this.ws) {
          // always send sync step 1 when connected
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          encoding.writeVarString(encoder, subdoc.guid);
          syncProtocol.writeSyncStep1(encoder, subdoc);
          this.send(encoding.toUint8Array(encoder), () => {
            subdoc.on("update", this._getSubDocUpdateHandler(subdoc.guid));
            console.log("writeSyncStep1 send");
          });
        }
      });
    });

    /**
     * @param {any} changed
     * @param {any} _origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      );
      broadcastMessage(this, encoding.toUint8Array(encoder));
    };
    this._unloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        "window unload"
      );
    };
    if (typeof window !== "undefined") {
      window.addEventListener("unload", this._unloadHandler);
    } else if (typeof process !== "undefined") {
      process.on("exit", this._unloadHandler);
    }
    awareness.on("update", this._awarenessUpdateHandler);
    this._checkInterval = /** @type {any} */ (
      setInterval(() => {
        if (
          this.wsconnected &&
          messageReconnectTimeout <
            time.getUnixTime() - this.wsLastMessageReceived
        ) {
          // no message received in a long time - not even your own awareness
          // updates (which are updated every 15 seconds)
          /** @type {WebSocket} */ (this.ws).close();
        }
      }, messageReconnectTimeout / 10)
    );
    if (connect) {
      this.connect();
    }
  }

  /**
   * @type {boolean}
   */
  get synced() {
    return this._synced;
  }

  set synced(state) {
    if (this._synced !== state) {
      this._synced = state;
      this.emit("synced", [state]);
      this.emit("sync", [state]);
      this.emit("status", [{ status: "synced", state }]);
    }
  }

  /**
   *
   * @param {string} id
   */
  getSubDoc(id) {
    return this.subdocs.get(id);
  }

  destroy() {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval);
    }
    clearInterval(this._checkInterval);
    try {
      this.disconnect();
    } catch (error) {
      // probably this error: https://github.com/yjs/y-protocols/issues/19
      console.error("provider destroy; error ignored", this.roomname, error);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("unload", this._unloadHandler);
    } else if (typeof process !== "undefined") {
      process.off("exit", this._unloadHandler);
    }
    this.awareness.off("update", this._awarenessUpdateHandler);
    this.doc.off("update", this._updateHandler);
    this.authenticated = false;
    super.destroy();
  }

  connectBc() {
    if (this.disableBc) {
      return;
    }
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber);
      this.bcconnected = true;
    }
    // send sync step1 to bc
    // write sync step 1
    const encoderSync = encoding.createEncoder();
    encoding.writeVarUint(encoderSync, messageSync);
    encoding.writeVarString(encoderSync, this.roomname);
    syncProtocol.writeSyncStep1(encoderSync, this.doc);
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
    // broadcast local state
    const encoderState = encoding.createEncoder();
    encoding.writeVarUint(encoderState, messageSync);
    encoding.writeVarString(encoderState, this.roomname);
    syncProtocol.writeSyncStep2(encoderState, this.doc);
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    );
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessState, messageAwareness);
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID,
      ])
    );
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    );
  }

  disconnectBc() {
    // broadcast message with local awareness state set to null (indicating disconnect)
    try {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          [this.doc.clientID],
          new Map()
        )
      );
      broadcastMessage(this, encoding.toUint8Array(encoder));
    } catch (error) {
      throw error;
    } finally {
      if (this.bcconnected) {
        bc.unsubscribe(this.bcChannel, this._bcSubscriber);
        this.bcconnected = false;
      }
    }
  }

  disconnect() {
    this.shouldConnect = false;
    this.authenticated = false;
    try {
      this.disconnectBc();
    } catch (error) {
      throw error;
    } finally {
      if (this.ws !== null) {
        this.ws.close();
      }
    }
  }

  connect() {
    this.shouldConnect = true;
    if (!this.wsconnected && this.ws === null) {
      setupWS(this);
      this.connectBc();
    }
  }
}
