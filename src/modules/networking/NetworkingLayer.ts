export interface SignalingMessage {
  type: string;
  payload: unknown;
}

export interface NetworkingLayer {
  connect(endpoint: string): Promise<void>;
  disconnect(): Promise<void>;
  send(message: SignalingMessage): Promise<void>;
}

export class WebSocketNetworkingLayer implements NetworkingLayer {
  async connect(_endpoint: string): Promise<void> {
    void _endpoint;
    return;
  }

  async disconnect(): Promise<void> {
    return;
  }

  async send(_message: SignalingMessage): Promise<void> {
    void _message;
    return;
  }
}
