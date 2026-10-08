export type WorkerNetworkRelease = () => void;

export class WorkerNetworkSwitch {
  static readonly VARIABLE = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
  static readonly ON = '1';
  static readonly shared = new WorkerNetworkSwitch(process.env);

  readonly #env: NodeJS.ProcessEnv;
  #holders = 0;
  #previous: string | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    this.#env = env;
  }

  get holders(): number {
    return this.#holders;
  }

  hold(): WorkerNetworkRelease {
    if (this.#holders === 0) {
      this.#previous = this.#env[WorkerNetworkSwitch.VARIABLE];
      this.#env[WorkerNetworkSwitch.VARIABLE] = WorkerNetworkSwitch.ON;
    }
    this.#holders++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#holders--;
      if (this.#holders > 0) return;
      if (this.#previous === undefined) delete this.#env[WorkerNetworkSwitch.VARIABLE];
      else this.#env[WorkerNetworkSwitch.VARIABLE] = this.#previous;
      this.#previous = undefined;
    };
  }
}
