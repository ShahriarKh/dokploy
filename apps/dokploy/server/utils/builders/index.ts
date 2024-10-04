import { createWriteStream } from "node:fs";
import type { InferResultType } from "@/server/types/with";
import type { CreateServiceOptions } from "dockerode";
import { uploadImage } from "../cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateFileMounts,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../docker/utils";
import { getRemoteDocker } from "../servers/remote-docker";
import { buildCustomDocker, getDockerCommand } from "./docker-file";
import { buildHeroku, getHerokuCommand } from "./heroku";
import { buildNixpacks, getNixpacksCommand } from "./nixpacks";
import { buildPaketo, getPaketoCommand } from "./paketo";
import { buildStatic, getStaticCommand } from "./static";

// NIXPACKS codeDirectory = where is the path of the code directory
// HEROKU codeDirectory = where is the path of the code directory
// PAKETO codeDirectory = where is the path of the code directory
// DOCKERFILE codeDirectory = where is the exact path of the (Dockerfile)
export type ApplicationNested = InferResultType<
	"applications",
	{ mounts: true; security: true; redirects: true; ports: true; registry: true }
>;
export const buildApplication = async (
	application: ApplicationNested,
	logPath: string,
) => {
	const writeStream = createWriteStream(logPath, { flags: "a" });
	const { buildType, sourceType } = application;
	try {
		writeStream.write(
			`\nBuild ${buildType}: ✅\nSource Type: ${sourceType}: ✅\n`,
		);
		console.log(`Build ${buildType}: ✅`);
		if (buildType === "nixpacks") {
			await buildNixpacks(application, writeStream);
		} else if (buildType === "heroku_buildpacks") {
			await buildHeroku(application, writeStream);
		} else if (buildType === "paketo_buildpacks") {
			await buildPaketo(application, writeStream);
		} else if (buildType === "dockerfile") {
			await buildCustomDocker(application, writeStream);
		} else if (buildType === "static") {
			await buildStatic(application, writeStream);
		}

		if (application.registryId) {
			await uploadImage(application, writeStream);
		}
		await mechanizeDockerContainer(application);
		writeStream.write("Docker Deployed: ✅");
	} catch (error) {
		if (error instanceof Error) {
			writeStream.write(`Error ❌\n${error?.message}`);
		} else {
			writeStream.write("Error ❌");
		}
		throw error;
	} finally {
		writeStream.end();
	}
};

export const getBuildCommand = (
	application: ApplicationNested,
	logPath: string,
) => {
	const { buildType } = application;
	switch (buildType) {
		case "nixpacks":
			return getNixpacksCommand(application, logPath);
		case "heroku_buildpacks":
			return getHerokuCommand(application, logPath);
		case "paketo_buildpacks":
			return getPaketoCommand(application, logPath);
		case "static":
			return getStaticCommand(application, logPath);
		case "dockerfile":
			return getDockerCommand(application, logPath);
	}
};

export const mechanizeDockerContainer = async (
	application: ApplicationNested,
) => {
	const {
		appName,
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		ports,
	} = application;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		Networks,
	} = generateConfigContainer(application);

	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(appName, application);
	const envVariables = prepareEnvironmentVariables(env);

	const image = getImageName(application);
	const authConfig = getAuthConfig(application);
	const docker = await getRemoteDocker(application.serverId);

	const settings: CreateServiceOptions = {
		authconfig: authConfig,
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: image,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(command
					? {
							Command: ["/bin/sh"],
							Args: ["-c", command],
						}
					: {}),
				Labels,
			},
			Networks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: {
			Ports: ports.map((port) => ({
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
		UpdateConfig,
	};

	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
	} catch (error) {
		await docker.createService(settings);
	}
};

const getImageName = (application: ApplicationNested) => {
	const { appName, sourceType, dockerImage, registry } = application;

	if (sourceType === "docker") {
		return dockerImage || "ERROR-NO-IMAGE-PROVIDED";
	}

	const registryUrl = registry?.registryUrl || "";
	const imagePrefix = registry?.imagePrefix ? `${registry.imagePrefix}/` : "";
	return registry
		? `${registryUrl}/${imagePrefix}${appName}`
		: `${appName}:latest`;
};

const getAuthConfig = (application: ApplicationNested) => {
	const { registry, username, password, sourceType } = application;

	if (sourceType === "docker") {
		if (username && password) {
			return {
				password,
				username,
				serveraddress: "https://index.docker.io/v1/",
			};
		}
	} else if (registry) {
		return {
			password: registry.password,
			username: registry.username,
			serveraddress: registry.registryUrl,
		};
	}

	return undefined;
};
