import { createHash } from "./deps.ts";
import { warn, critical } from "./logging.ts";
import { timeout } from "./util.ts";

const skdVersion = "UE4MKPL-1.49.201027";
const titleId = "5EA1"; // seu TitleId do PlayFab

interface PlayfabServerTags {
    maxPlayers: number;
    numPlayers: number;
    isFull: boolean;
    gameId: string;
    gameBuild: string;
    serverName: string;
    category: string;
    publicSigningKey: string;
    requiresPassword: boolean;
}

export interface PlayfabServer {
    Region: string;
    LobbyID: string;
    BuildVersion: string;
    GameMode: string;
    PlayerUserIds: string[];
    RunTime: number;
    GameServerState: number;
    GameServerStateEnum: string;
    Tags: PlayfabServerTags;
    LastHeartbeat: string;
    ServerHostname: string;
    ServerIPV4Address: string;
    ServerPort: number;
}

export class PlayfabManager {
    private servers: string[] = [];
    private serversData: PlayfabServer[] = [];
    private headers: Record<string, string> = {
        "Accept": "*/*",
        "Accept-Encoding": "none",
        "Content-Type": "application/json; charset=utf-8",
        "X-PlayFabSDK": skdVersion,
        "User-Agent":
            "Astro/++UE4+Release-4.23-CL-0 Windows/10.0.19041.1.768.64bit",
    };
    private lastSuccesfullQuery = 0;
    private lastAuth = 0;
    private accountId = "";
    private deregisteredServers: Record<string, number> = {};

    constructor() {
        this.lastSuccesfullQuery = Date.now();
    }

    async update() {
        const fetchData = async () => {
            await this.ensureAuth();

            let serverRes: any = null;
            try {
                const res = await fetch(`https://${titleId}.playfabapi.com/Client/GetCurrentGames?sdk=${skdVersion}`, {
                    method: "POST",
                    body: JSON.stringify({
                        TagFilter: {
                            Includes: this.servers.map(s => ({ Data: { gameId: s } }))
                        },
                    }),
                    headers: this.headers,
                });

                if (!res.ok) {
                    warn(`Playfab query failed with status ${res.status}`);
                    return;
                }

                serverRes = await res.json().catch(() => null);
                if (!serverRes) {
                    warn("Playfab returned invalid or empty JSON, skipping update");
                    return;
                }
            } catch (err) {
                warn(`Playfab request error: ${err.message}`);
                return;
            }

            if (!serverRes?.data?.Games) {
                warn("Playfab response missing 'Games' data, skipping update");
                return;
            }

            this.serversData = [];

            serverRes.data.Games.forEach((s: any) => {
                if (this.deregisteredServers[s.Tags.gameId] > 0) {
                    this.deregisteredServers[s.Tags.gameId] -= 1;
                    return;
                } else {
                    delete this.deregisteredServers[s.Tags.gameId];
                }

                const tags: PlayfabServerTags = {
                    maxPlayers: parseInt(s.Tags.maxPlayers),
                    numPlayers: parseInt(s.Tags.numPlayers),
                    isFull: s.Tags.isFull === "true",
                    gameId: s.Tags.gameId,
                    gameBuild: s.Tags.gameBuild,
                    serverName: s.Tags.serverName,
                    category: s.Tags.category,
                    publicSigningKey: s.Tags.publicSigningKey,
                    requiresPassword: s.Tags.requiresPassword === "true"
                };
                const server: PlayfabServer = {
                    Region: s.Region,
                    LobbyID: s.LobbyID,
                    BuildVersion: s.BuildVersion,
                    GameMode: s.GameMode,
                    PlayerUserIds: s.PlayerUserIds,
                    RunTime: s.RunTime,
                    GameServerState: s.GameServerState,
                    GameServerStateEnum: s.GameServerStateEnum,
                    Tags: tags,
                    LastHeartbeat: s.LastHeartbeat,
                    ServerHostname: s.ServerHostname,
                    ServerIPV4Address: s.ServerIPV4Address,
                    ServerPort: s.ServerPort
                };
                this.serversData.push(server);
            });

            this.lastSuccesfullQuery = Date.now();
        };

        try {
            await timeout(1000, fetchData());
        } catch (_) {
            warn("Playfab server query failed (timeout)");
            if (this.lastSuccesfullQuery + (3600 * 1000) < Date.now()) {
                critical("Could not connect for playfab for 1 hour, quitting");
                warn("This will not stop the server processes, CHECK TASKMANAGER");
                Deno.exit(1);
            }
        }
    }

    async ensureAuth() {
        if (this.lastAuth + (3600 * 1000) < Date.now()) {
            try {
                const resXAUTH = await this.sendLoginAuth(false);
                let json: any = null;
                try {
                    json = await resXAUTH.json();
                } catch {
                    warn("Playfab login returned invalid JSON");
                }

                if (resXAUTH.status === 400) {
                    const resXAUTHCreate = await this.sendLoginAuth(true);
                    const createJson = await resXAUTHCreate.json().catch(() => null);
                    if (createJson?.data?.SessionTicket) {
                        this.headers["X-Authorization"] = createJson.data.SessionTicket;
                    } else {
                        warn("Playfab account creation failed");
                    }
                } else if (json?.data?.SessionTicket) {
                    this.headers["X-Authorization"] = json.data.SessionTicket;
                }
                this.lastAuth = Date.now();
            } catch (err) {
                warn(`Playfab auth failed: ${err.message}`);
            }
        }
    }

    sendLoginAuth(createAccount: boolean) {
        return fetch(`https://${titleId}.playfabapi.com/Client/LoginWithCustomID?sdk=${skdVersion}`, {
            method: "POST",
            body: JSON.stringify({
                CreateAccount: createAccount,
                CustomId: "astro-starter_" + this.accountId,
                TitleId: titleId,
            }),
            headers: this.headers,
        });
    }

    add(server: string) {
        this.servers.push(server);
        const IPs = this.servers.reduce((a, c) => a + c, "");
        const hash = createHash("md5");
        hash.update(IPs);
        this.accountId = hash.toString();
    }

    get(server: string): PlayfabServer | undefined {
        return this.serversData.find(s => server === s.Tags.gameId);
    }

    deregisterServer(IP: string) {
        this.serversData.filter(s => IP === s.Tags.gameId).forEach(async server => {
            try {
                const res = await fetch(`https://${titleId}.playfabapi.com/Client/ExecuteCloudScript?sdk=${skdVersion}`, {
                    method: "POST",
                    body: JSON.stringify({
                        FunctionName: "deregisterDedicatedServer",
                        FunctionParameter: { lobbyId: server.LobbyID },
                        GeneratePlayStreamEvent: true
                    }),
                    headers: this.headers,
                });
                await res.json().catch(() => null);
            } catch (err) {
                warn(`Failed to deregister server: ${err.message}`);
            }
        });
        this.deregisteredServers[IP] = 4;
    }

    async heartbeatServer(serverData: PlayfabServer) {
        try {
            const res = await fetch(`https://${titleId}.playfabapi.com/Client/ExecuteCloudScript?sdk=${skdVersion}`, {
                method: "POST",
                body: JSON.stringify({
                    FunctionName: "heartbeatDedicatedServer",
                    FunctionParameter: {
                        serverName: serverData.Tags.serverName,
                        buildVersion: serverData.Tags.gameBuild,
                        gameMode: serverData.Tags.category,
                        ipAddress: serverData.ServerIPV4Address,
                        port: serverData.ServerPort,
                        matchmakerBuild: serverData.BuildVersion,
                        maxPlayers: serverData.Tags.maxPlayers,
                        numPlayers: serverData.PlayerUserIds.length.toString(),
                        lobbyId: serverData.LobbyID,
                        publicSigningKey: serverData.Tags.publicSigningKey,
                        requiresPassword: serverData.Tags.requiresPassword
                    },
                    GeneratePlayStreamEvent: true
                }),
                headers: this.headers,
            });
            await res.json().catch(() => {
                warn("Playfab heartbeat returned empty or invalid JSON");
            });
        } catch (err) {
            warn(`Playfab heartbeat error: ${err.message}`);
        }
    }
}
