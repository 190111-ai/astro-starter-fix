import { path, fs, io, Colors } from "./deps.ts"

import { Server } from "./Server.ts";
import { PlayfabManager } from "./playfab.ts";
import { parseConfig } from "./config.ts"
import { defaultConfig } from "./defaultConfig.ts"
import { WebServer } from "./web.ts";
import { PlayerCache } from "./PlayerCache.ts";

import { setLogDir, info, warn, critical } from "./logging.ts"

export class Starter {
    public version = "1.0.2"
    public latestVersion = ""  // placeholder, não é usado
    public servers: Server[] = []
    public playfab = new PlayfabManager()
    public playerCache = new PlayerCache(this)

    public webserverPort = 5000
    private webserver = new WebServer(this)

    public owner = ""
    public publicIP = ""

    private loop = 0
    private lastPublucDataFetch = 0

    public onlineSince = Date.now()
    public rconErrorRestart = false

    constructor(public dir: string) {
        fs.ensureDirSync(path.join(this.dir, "starterData", "servers"))
        setLogDir(path.join(this.dir, "starterData", "logs"))

        console.log("")
        info(`astro-starter v${this.version}`)
        info("work dir: " + dir)

        this.readConfig()
        this.webserver = new WebServer(this)
        this.playerCache = new PlayerCache(this)
    }

    readConfig() {
        const configPath = path.join(this.dir, "starter.json")

        if (!fs.existsSync(configPath)) {
            info("No config file found, creating new one")

            if (Deno.build.os === "windows")
                Deno.writeTextFileSync(path.join(this.dir, "start.bat"), '"./astro-starter.exe"\npause')

            Deno.writeTextFileSync(configPath, JSON.stringify(defaultConfig, null, "    "))

            info(Colors.brightBlue("Please edit starter.json"))
            Deno.exit(0)
        }

        parseConfig(configPath, this)
    }

    async start() {
        fs.ensureDirSync(path.join(this.dir, "starterData", "servers"))

        if (this.servers.length === 0) {
            warn("No servers configured, exiting")
            Deno.exit(0)
        }

        await this.fetchPublicData()
        await this.playerCache.readFile()

        if (this.servers.filter(s => s.serverType === "local").length > 0) {
            await this.updateSteam()
        }

        for (const server of this.servers) {
            await server.init()
        }

        this.webserver.listen()

        for (const server of this.servers) {
            server.start()
        }
        info("Server processes starting...")

        this.loop = setInterval(async () => {
            await this.playfab.update()

            for (const server of this.servers) {
                server.update()
            }
        }, 4000)

        setTimeout(() => {
            if (fs.existsSync("./silent")) {
                Deno.removeSync("./silent")
            }
        }, 60000)
    }

    async updateSteam() {
        const steamDir = path.join(this.dir, "starterData", "steamcmd")
        fs.ensureDirSync(steamDir)

        const steamCmdPath = path.join(steamDir, "steamcmd.exe")

        // Baixar SteamCMD se não existir
        if (Deno.build.os === "windows" && !fs.existsSync(steamCmdPath)) {
            info("Downloading SteamCMD...")

            const response = await fetch("https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip")
            const blob = await response.arrayBuffer()
            const zipFile = path.join(steamDir, "steamcmd.zip")
            await Deno.writeFile(zipFile, new Uint8Array(blob))

            // Extrair o zip usando PowerShell
            const unzip = Deno.run({
                cmd: [
                    "PowerShell",
                    "Expand-Archive",
                    "-Path", zipFile,
                    "-DestinationPath", steamDir
                ],
                stdout: "piped",
                stderr: "piped",
            })
            await unzip.status()
            unzip.close()
            Deno.removeSync(zipFile)
            info("SteamCMD downloaded and extracted successfully")
        }

        info("Downloading/updating server files from Steam...")

        // Executar SteamCMD
        const p = Deno.run({
            cmd: [
                Deno.build.os === "windows" ? steamCmdPath : "steamcmd",
                "+login", "anonymous",
                "+@sSteamCmdForcePlatformType", "windows",
                "+force_install_dir", path.join(this.dir, "starterData", "serverfiles"),
                "+app_update", "728470", "validate",
                "+quit"
            ],
            stdout: "piped",
            stderr: "piped",
        })

        for await (const line of io.readLines(p.stdout)) {
            info(line)
        }

        const { code } = await p.status()
        info("SteamCMD finished with code: " + code)

        try {
            await Deno.remove(path.join(this.dir, "starterData", "serverfiles", "steamapps"), { recursive: true })
        } catch (e) {
            warn("Failed to cleanup steam, continuing...")
            console.error(e)
        }
    }

    async fetchPublicData() {
        if (Date.now() - this.lastPublucDataFetch < 60000) return
        this.lastPublucDataFetch = Date.now()

        info("Fetching public data...")

        this.publicIP = (await (await fetch("https://api.ipify.org")).text())
        info("Public IP: " + this.publicIP)
    }

    shutdown(silent = false) {
        info("Shutting down servers and starter")

        if (silent) {
            this.servers.forEach(s => (s.webhook = ""))
            const data = new Uint8Array([])
            Deno.writeFileSync("./silent", data)
        }

        this.servers.forEach(s => {
            if (s.serverType === "local") s.stop()
        })
        setTimeout(() => {
            clearInterval(this.loop)
            console.log("Bye! Thanks for using astro-starter")
            Deno.exit(0)
        }, 20000)
    }
}
