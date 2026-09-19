import fs from "fs";
import net from "net";

export type TTcpConnectionOptions = {
  host: string;
  port: number;
};

export type TTcpConnectionLifecycleOptions = {
  reConnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
};

export type TTcpClientTlsSecretMode = "file" | "memory";

export type TTcpClientTlsSecretFileOptions = {
  enabled: boolean;
  mode: "file";
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  passphrase?: string;
};

export type TTcpClientTlsSecretMemoryOptions = {
  enabled: boolean;
  mode: "memory";
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
};

export type TTcpClientTlsOptions =
  | TTcpClientTlsSecretFileOptions
  | TTcpClientTlsSecretMemoryOptions;

export type TcpClientOptions = {
  connection: TTcpConnectionOptions;
  lifecycle: TTcpConnectionLifecycleOptions;
  tls: TTcpClientTlsOptions;
  maxErrors?: number;
};

type TPreprocessedTcpClientOptions = {
  connection: TTcpConnectionOptions;
  lifecycle: TTcpConnectionLifecycleOptions;
  tls: TTcpClientTlsSecretMemoryOptions | undefined;
  maxErrors: number;
};

export type TClientState = {
  state: "disconnected" | "connecting" | "connected" | "disconnected";
  // these are preprocessed from at the top of the state value.
  connected: boolean;
  connecting: boolean;
  disconnected: boolean;
  lastErr: Error | undefined;

  // max 20 (this is basically a ring buffer shit :)
  givenErrors: Error[];
  socket: net.Socket | undefined;
};

// helpers
function loadTlsFromFile(
  options: TTcpClientTlsSecretFileOptions,
): TTcpClientTlsSecretMemoryOptions {
  if (!options.caPath || !options.certPath || !options.keyPath) {
    throw new Error("caPath, certPath and keyPath are required");
  }

  return {
    enabled: true,
    mode: "memory",
    ca: fs.readFileSync(options.caPath!),
    cert: fs.readFileSync(options.certPath!),
    key: fs.readFileSync(options.keyPath!),
  };
}

// main class
export class CTcpClient {
  private initialized = false;
  private state: TClientState = {
    state: "disconnected",
    connected: false,
    connecting: false,
    disconnected: true,
    lastErr: undefined,
    givenErrors: [],
    socket: undefined,
  };

  private eventListeners: Record<string, (...args: any[]) => void> = {};

  // preprocessed options
  private preprocessedOptions!: TPreprocessedTcpClientOptions;

  constructor(private readonly options: TcpClientOptions) {
    this.options = options;
  }

  initialize() {
    this.preprocessedOptions = this.preprocessOptions(this.options);
  }

  bindEvent(
    event: "data" | "error" | "close" | "connect",
    callback: (...args: any[]) => void,
  ) {
    // add the callback to the event listeners
    this.eventListeners[event] = callback;
  }

  unbindEvent(event: "data" | "error" | "close" | "connect") {
    delete this.eventListeners[event];
  }

  private preprocessOptions(
    options: TcpClientOptions,
  ): TPreprocessedTcpClientOptions {
    let baseOptions: TPreprocessedTcpClientOptions = {
      connection: options.connection,
      lifecycle: options.lifecycle,
      tls: undefined,
      maxErrors: options.maxErrors ?? 20,
    };

    if (options.tls.enabled) {
      baseOptions.tls =
        options.tls.mode === "file"
          ? loadTlsFromFile(options.tls)
          : options.tls;

      // Bu hatayı sana basıyorum tatlım.
      if (
        !baseOptions.tls.ca ||
        !baseOptions.tls.cert ||
        !baseOptions.tls.key
      ) {
        throw new Error("ca, cert and key are required");
      }
    }

    // baba hepsini topladık geriye döndük.
    return {
      connection: baseOptions.connection,
      lifecycle: baseOptions.lifecycle,
      tls: baseOptions.tls,
      maxErrors: baseOptions.maxErrors,
    };
  }

  private emit(event: "data" | "error" | "close" | "connect", ...args: any[]) {
    if (this.eventListeners[event]) {
      this.eventListeners[event](...args);
    }
  }

  connect() {
    this.state.state = "connecting";
    this.state.connecting = true;
    this.state.disconnected = false;
    this.state.lastErr = undefined;
    this.state.givenErrors = [];

    // connect to the server
    const socket = net.connect({
      host: this.preprocessedOptions.connection.host,
      port: this.preprocessedOptions.connection.port,
    });

    // reset the socket at the state value.
    this.state.socket = socket;

    socket.on("error", (err) => {
      this.error(err);
    });

    socket.on("connect", () => {
      this.connected();
    });

    socket.on("close", () => {
      this.closed();
    });

    socket.on("data", (data) => {
      this.data(Buffer.from(data));
    });
  }

  // in class helpers
  private addError(error: Error) {
    // set last error
    this.state.lastErr = error;

    // add to given errors
    this.state.givenErrors.push(error);
    if (this.state.givenErrors.length > this.preprocessedOptions.maxErrors) {
      this.state.givenErrors.shift();
    }
  }

  // unused but i think this will be useful later.
  private resetState() {
    this.state.state = "disconnected";
    this.state.connected = false;
    this.state.connecting = false;
    this.state.disconnected = true;
    this.state.lastErr = undefined;
    this.state.givenErrors = [];
    this.state.socket = undefined;
  }

  private closed() {
    this.state.state = "disconnected";
    this.state.connected = false;
    this.state.connecting = false;
    this.state.disconnected = true;

    this.state.socket?.destroy();
    this.state.socket = undefined;

    this.emit("close");
  }

  private connected() {
    this.state.state = "connected";
    this.state.connected = true;
    this.state.connecting = false;
    this.state.disconnected = false;

    this.emit("connect");
  }

  private error(error: Error) {
    // close the connection
    this.closed();

    // add the error to the state
    this.addError(error);

    // emit the error event
    this.emit("error", error);
  }

  private data(data: Buffer) {
    this.emit("data", data);
  }
}
