import React, {
  createContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  // types
  Connection,
  HassEntities,
  HassEntity,
  HassConfig,
  HassUser,
  HassServices,
  HassServiceTarget,
  getAuthOptions as AuthOptions,
  ERR_HASS_HOST_REQUIRED,
  Auth,
  UnsubscribeFunc,
  // methods
  getAuth,
  createConnection,
  subscribeEntities,
  callService as _callService,
  getStates as _getStates,
  getServices as _getServices,
  getConfig as _getConfig,
  getUser as _getUser,
} from "home-assistant-js-websocket";
import { useDebouncedCallback } from "use-debounce";
import { isArray, snakeCase } from "lodash";
import {
  ServiceData,
  DomainName,
  DomainService,
} from "../../types/supported-services";

interface CallServiceArgs<T extends DomainName, M extends DomainService<T>> {
  domain: T;
  service: M;
  serviceData?: ServiceData<T, M>;
  target?: HassServiceTarget | string | string[];
}

export interface HassContextProps {
  /** The connection object from home-assistant-js-websocket */
  connection: Connection | null;
  /** This is an internal function, no need to use this */
  setConnection: (connection: Connection) => void;
  /** will retrieve a HassEntity from the context */
  getEntity: (entity: string) => HassEntity;
  /** will retrieve all HassEntities from the context */
  getAllEntities: () => HassEntities;
  /** will call a service for home assistant */
  callService: <T extends DomainName, M extends DomainService<T>>(
    args: CallServiceArgs<T, M>
  ) => void;
  /** will retrieve all the HassEntities states */
  getStates: () => Promise<HassEntity[] | null>;
  /** will retrieve all the HassServices */
  getServices: () => Promise<HassServices | null>;
  /** will retrieve HassConfig */
  getConfig: () => Promise<HassConfig | null>;
  /** will retrieve HassUser */
  getUser: () => Promise<HassUser | null>;
  /** This is an internal value, no need to use this */
  ready: boolean;
  /** The last time the context object was updated */
  lastUpdated: Date;
}

export const HassContext = createContext<HassContextProps>(
  {} as HassContextProps
);

interface HassProviderProps {
  children: (ready: boolean) => React.ReactNode;
  hassUrl: string;
  throttle?: number;
}

export function HassProvider({
  children,
  hassUrl,
  throttle = 150,
}: HassProviderProps) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [ready, setReady] = useState(false);
  const auth = useRef<Auth | null>(null);
  const unsubscribe = useRef<UnsubscribeFunc | null>(null);
  const [_entities, setEntities] = useState<HassEntities>({});
  const [error, setError] = useState<string | null>(null);
  const getStates = useCallback(
    async () => (connection === null ? null : await _getStates(connection)),
    [connection]
  );
  const getServices = useCallback(
    async () => (connection === null ? null : await _getServices(connection)),
    [connection]
  );
  const getConfig = useCallback(
    async () => (connection === null ? null : await _getConfig(connection)),
    [connection]
  );
  const getUser = useCallback(
    async () => (connection === null ? null : await _getUser(connection)),
    [connection]
  );
  const getAllEntities = useCallback(() => _entities, [_entities]);
  const getEntity = useCallback(
    (entity: string) => {
      const found = _entities[entity];
      if (!found) throw new Error(`Entity ${entity} not found`);
      return found;
    },
    [_entities]
  );
  const setEntitiesDebounce = useDebouncedCallback<
    (entities: HassEntities) => void
  >((entities) => {
    setEntities(entities);
    setLastUpdated(new Date());
    if (!ready) setReady(true);
  }, throttle);
  const getAuthOptions = useCallback(
    (hassUrl: string): AuthOptions => ({
      hassUrl,
      async loadTokens() {
        try {
          const tokens = JSON.parse(localStorage.hassTokens);
          const { origin: inputOrigin } = new URL(hassUrl);
          const { origin: tokenOrigin } = new URL(tokens.hassUrl);
          // abort the authentication if the token url doesn't match
          if (inputOrigin !== tokenOrigin) return null;
          return tokens;
        } catch (err) {
          if (err instanceof Error) {
            setError(err.message);
          }
        }
      },
      saveTokens: (tokens) => {
        localStorage.hassTokens = JSON.stringify(tokens);
      },
    }),
    []
  );

  const callService = useCallback(
    async <T extends DomainName, M extends DomainService<T>>({
      domain,
      service,
      serviceData,
      target: _target,
    }: CallServiceArgs<T, M>) => {
      const target =
        typeof _target === "string" || isArray(_target)
          ? {
              entity_id: _target,
            }
          : _target;
      if (typeof service !== "string") {
        throw new Error("service must be a string");
      }
      if (connection && ready) {
        return await _callService(
          connection,
          snakeCase(domain),
          snakeCase(service),
          // purposely cast here as we know it's correct
          serviceData as object,
          target
        );
      }
      return false;
    },
    [connection, ready]
  );

  useEffect(() => {
    // when the hassUrl changes, reset some properties
    setReady(false);
    setEntities({});
    setConnection(null);
    auth.current = null;
    if (unsubscribe.current) {
      unsubscribe.current();
      unsubscribe.current = null;
    }
  }, [hassUrl]);

  useEffect(() => {
    if (connection === null) return;
    unsubscribe.current = subscribeEntities(connection, ($entities) => {
      setEntitiesDebounce($entities);
    });
    if (location.search.includes("auth_callback=1")) {
      history.replaceState(null, "", location.pathname);
    }
    return () => {
      // on unmount, unsubscribe
      if (unsubscribe.current) {
        unsubscribe.current();
        unsubscribe.current = null;
      }
    };
  }, [connection, setEntitiesDebounce]);

  const authenticate = useCallback(async () => {
    if (typeof hassUrl !== "string") return;
    if (error !== null) setError(null);
    try {
      auth.current = await getAuth(getAuthOptions(hassUrl));
      if (auth.current.expired) {
        auth.current.refreshAccessToken();
      }
    } catch (err) {
      if (err === ERR_HASS_HOST_REQUIRED) {
        auth.current = await getAuth(getAuthOptions(hassUrl));
      } else {
        if (err instanceof Error) {
          setError(err.message);
        }
        return;
      }
    }
    const connection = await createConnection({ auth: auth.current });
    setConnection(connection);
  }, [getAuthOptions, hassUrl, error]);

  useEffect(() => {
    if (!ready) {
      try {
        authenticate();
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        }
      }
    }
  }, [
    authenticate,
    getAuthOptions,
    hassUrl,
    ready,
    setConnection,
    setEntitiesDebounce,
  ]);

  return (
    <HassContext.Provider
      value={{
        connection,
        setConnection,
        getEntity,
        getAllEntities,
        callService,
        getStates,
        getServices,
        getConfig,
        getUser,
        ready,
        lastUpdated,
      }}
    >
      {error === null ? children(ready) : error}
    </HassContext.Provider>
  );
}
