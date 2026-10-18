import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  aws_ec2 as ec2,
  type aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

/** Isolated Hub services for an explicitly selected environment. */
export class HubServices extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      environment: string;
      hostname: string;
      vpc: ec2.IVpc;
      cluster: ecs.ICluster;
      listener: elbv2.IApplicationListener;
      serviceSecurityGroup: ec2.ISecurityGroup;
      albSecurityGroup: ec2.ISecurityGroup;
      repository: ecr.IRepository;
      imageTag: string;
      databaseHost: string;
      databaseSecret: sm.ISecret;
      ready: boolean;
      productionAuthorized?: boolean;
      originVerifyHeader?: string;
    },
  ) {
    super(scope, id);
    if (
      props.environment !== "staging" &&
      !(
        props.environment === "production" &&
        props.productionAuthorized &&
        props.originVerifyHeader
      )
    )
      throw new Error("Production Hub requires explicit provisioning authorization");
    const stack = Stack.of(this);
    const group = new logs.LogGroup(this, "Logs", {
      logGroupName: `/sgsdattasannidhi/${props.environment}/hub`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const assets = new s3.Bucket(this, "Assets", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });
    const secret = (name: string) =>
      ecs.Secret.fromSecretsManager(
        sm.Secret.fromSecretCompleteArn(
          this,
          `P${name}`,
          Fn.importValue(`sgs-${props.environment}-hub-${name.replaceAll("_", "-")}`),
        ),
      );
    const sharedSecrets = {
      DISTRIBUTION_DATABASE_URL: secret("DISTRIBUTION_DATABASE_URL"),
      STUDIO_CHANNEL_CONFIG_KEY: secret("STUDIO_CHANNEL_CONFIG_KEY"),
      STUDIO_WORKER_AUTHORIZATION_KEY: secret("STUDIO_WORKER_AUTHORIZATION_KEY"),
    };
    // Preserve the separately provisioned browser/importer on later application releases.
    // Fresh environments can bootstrap the Hub first, then enable this after provisioning it.
    const importVerification = this.node.tryGetContext("importVerification") === "true";
    const importSecret = importVerification
      ? sm.Secret.fromSecretCompleteArn(
          this,
          "ImportVerificationSecret",
          Fn.importValue(`sgs-${props.environment}-hub-import-verification-secret`),
        )
      : undefined;
    const environment = {
      NODE_ENV: "production",
      DEPLOY_ENV: props.environment,
      DISTRIBUTION_HUB_ENABLED: "true",
      DISTRIBUTION_HUB_STAGE: "LIMITED",
      DISTRIBUTION_CORE_ORIGIN: `https://${props.hostname}`,
      DISTRIBUTION_APP_ORIGIN: `https://${props.hostname}`,
      STUDIO_CORE_ORIGIN: `https://${props.hostname}`,
      STUDIO_PUBLIC_ORIGIN: `https://${props.hostname}`,
      STUDIO_WORKER_AUTHORIZATION_ENABLED: "true",
      STUDIO_GENERATION_ENABLED: "true",
      STUDIO_WORKER_ENABLED: "true",
      STUDIO_PUBLISHING_ENABLED: "false",
      STUDIO_INTELLIGENCE_PROVIDER: "gemini",
      STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
      STUDIO_GEMINI_MODEL: "gemini-3.5-flash",
      STUDIO_SARVAM_MODEL: "saaras:v4",
      STUDIO_GEMINI_CONFIGURED: "true",
      STUDIO_SARVAM_CONFIGURED: "true",
      STUDIO_CHANNEL_CONFIG_BACKEND: "database",
      DISTRIBUTION_ASSET_BACKEND: "s3",
      DISTRIBUTION_S3_BUCKET: assets.bucketName,
      DISTRIBUTION_S3_REGION: stack.region,
      DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: stack.account,
      DISTRIBUTION_S3_PREFIX: "production/",
    };
    const makeTask = (
      name: string,
      image: string,
      cpu: number,
      memory: number,
      secrets: Record<string, ecs.Secret>,
      extra: Record<string, string> = {},
    ) => {
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `sgsdattasannidhi-${props.environment}-${name}`,
        cpu,
        memoryLimitMiB: memory,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      const container = task.addContainer(name, {
        image: ecs.ContainerImage.fromEcrRepository(props.repository, `${image}-${props.imageTag}`),
        environment: {
          ...environment,
          ...(name === "hub-studio" ? { STUDIO_HEALTH_PORT: "3072" } : {}),
          ...extra,
        },
        secrets,
        command: name === "hub-migrate" ? ["node", "ops/staging-bootstrap.mjs"] : undefined,
        logging: ecs.LogDrivers.awsLogs({ logGroup: group, streamPrefix: name }),
        healthCheck:
          name === "hub-studio"
            ? {
                command: [
                  "CMD",
                  "node",
                  "-e",
                  "fetch('http://127.0.0.1:3072',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
                ],
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                retries: 3,
                startPeriod: Duration.seconds(30),
              }
            : undefined,
      });
      return { task, container };
    };
    const web = makeTask(
      "hub-web",
      "distribution-web",
      512,
      2048,
      {
        ...sharedSecrets,
        ...(importSecret
          ? {
              STUDIO_IMPORT_VERIFICATION_KEY: ecs.Secret.fromSecretsManager(importSecret, "key"),
              STUDIO_IMPORT_VERIFICATION_CA: ecs.Secret.fromSecretsManager(
                importSecret,
                "certificate",
              ),
            }
          : {}),
      },
      importVerification
        ? {
            STUDIO_IMPORT_VERIFICATION_ORIGIN: Fn.importValue(
              `sgs-${props.environment}-hub-import-verification-origin`,
            ),
          }
        : {},
    );
    web.container.addPortMappings({ containerPort: 3070 });
    assets.grantReadWrite(web.task.taskRole, "production/*");
    const worker = makeTask(
      "hub-studio",
      "distribution-studio",
      2048,
      4096,
      {
        ...sharedSecrets,
        STUDIO_SARVAM_API_KEY: secret("STUDIO_SARVAM_API_KEY"),
        STUDIO_GEMINI_API_KEY: secret("STUDIO_GEMINI_API_KEY"),
      },
      importVerification ? { STUDIO_WORKER_MODE: "generation" } : {},
    );
    assets.grantReadWrite(worker.task.taskRole, "production/*");
    const migrator = makeTask(
      "hub-migrate",
      "distribution-migrate",
      512,
      1024,
      {
        ...sharedSecrets,
        DISTRIBUTION_MIGRATION_DATABASE_URL: secret("DISTRIBUTION_MIGRATION_DATABASE_URL"),
        HUB_DATABASE_ADMIN_USER: ecs.Secret.fromSecretsManager(props.databaseSecret, "username"),
        HUB_DATABASE_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(
          props.databaseSecret,
          "password",
        ),
      },
      {
        HUB_DATABASE_HOST: props.databaseHost,
        ...(props.environment === "production"
          ? { HUB_PRODUCTION_BOOTSTRAP: "explicit-predeploy" }
          : {}),
      },
    );
    const service = (name: string, task: ecs.FargateTaskDefinition) =>
      new ecs.FargateService(this, name, {
        cluster: props.cluster,
        serviceName: name,
        taskDefinition: task,
        desiredCount: props.ready ? 1 : 0,
        securityGroups: [props.serviceSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      });
    const webService = service("hub-web", web.task);
    service("hub-studio", worker.task);
    const conditions = [
      elbv2.ListenerCondition.hostHeaders([props.hostname]),
      ...(props.originVerifyHeader
        ? [elbv2.ListenerCondition.httpHeader("x-origin-verify", [props.originVerifyHeader])]
        : []),
      elbv2.ListenerCondition.pathPatterns(["/distribution", "/distribution/*"]),
    ];
    const targetOptions = {
      port: 3070,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: "/distribution/api/healthz",
        healthyThresholdCount: 2,
        interval: Duration.seconds(15),
      },
    };
    if (props.environment === "production") {
      const targetGroup = new elbv2.ApplicationTargetGroup(this, "ProductionTargets", {
        vpc: props.vpc,
        ...targetOptions,
      });
      webService.connections.allowFrom(props.albSecurityGroup, ec2.Port.tcp(3070));
      props.listener.addTargetGroups("HubTargets", {
        priority: 15,
        conditions,
        targetGroups: [targetGroup],
      });
    } else {
      props.listener.addTargets("HubTargets", { priority: 15, conditions, ...targetOptions });
    }
    new CfnOutput(this, "MigrationTask", { value: migrator.task.taskDefinitionArn });
    new CfnOutput(this, "AssetBucket", { value: assets.bucketName });
  }
}
