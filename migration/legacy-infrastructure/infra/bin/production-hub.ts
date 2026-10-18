#!/usr/bin/env node
// MFA-only deployment. Imports production networking; owns no core resources.
import { readFileSync } from "node:fs";
import {
  App,
  CfnParameter,
  Stack,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import { HubServices } from "../lib/hub-services";
const app = new App();
if (app.node.tryGetContext("productionHubAuthorized") !== "true")
  throw Error("Explicit production authorization required");
const c = JSON.parse(readFileSync(app.node.tryGetContext("productionConfig"), "utf8"));
if (
  c.account !== "510724490093" ||
  c.region !== "ap-south-1" ||
  c.clusterName !== "sgsdattasannidhi-production" ||
  !/^[a-f0-9]{12}$/.test(c.imageTag)
)
  throw Error("Invalid production release configuration");
const stack = new Stack(app, "SgsDattaSannidhiHub-production", {
  env: { account: c.account, region: c.region },
});
const vpc = ec2.Vpc.fromVpcAttributes(stack, "Vpc", {
  vpcId: c.vpcId,
  availabilityZones: c.availabilityZones,
  privateSubnetIds: c.privateSubnetIds,
});
const serviceSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
  stack,
  "Services",
  c.serviceSecurityGroupId,
);
const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(stack, "Alb", c.albSecurityGroupId);
new HubServices(stack, "Hub", {
  environment: "production",
  hostname: "sgsdattasannidhi.org",
  vpc,
  cluster: ecs.Cluster.fromClusterAttributes(stack, "Cluster", {
    clusterName: c.clusterName,
    vpc,
    securityGroups: [serviceSecurityGroup],
  }),
  listener: elbv2.ApplicationListener.fromApplicationListenerAttributes(stack, "Listener", {
    listenerArn: c.listenerArn,
    securityGroup: albSecurityGroup,
  }),
  serviceSecurityGroup,
  albSecurityGroup,
  repository: ecr.Repository.fromRepositoryName(stack, "Images", "sgsdattasannidhi"),
  imageTag: c.imageTag,
  databaseHost: c.databaseHost,
  databaseSecret: sm.Secret.fromSecretCompleteArn(stack, "DatabaseAdmin", c.databaseSecretArn),
  ready: app.node.tryGetContext("hubReady") === "true",
  productionAuthorized: true,
  originVerifyHeader: new CfnParameter(stack, "OriginVerificationHeader", {
    type: "String",
    noEcho: true,
    minLength: 32,
  }).valueAsString,
});
app.synth();
