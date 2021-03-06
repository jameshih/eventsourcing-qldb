import * as cdk from '@aws-cdk/core';
import { CfnLedger, CfnStream } from '@aws-cdk/aws-qldb';
import { Role, ServicePrincipal, ManagedPolicy, PolicyDocument, PolicyStatement, Effect } from '@aws-cdk/aws-iam';
import * as Kinesis from '@aws-cdk/aws-kinesis';
import { Runtime, Code, Function, StartingPosition } from '@aws-cdk/aws-lambda';
import { Duration, CfnOutput, RemovalPolicy } from '@aws-cdk/core';
import { RestApi, LambdaIntegration } from '@aws-cdk/aws-apigateway';
import { CfnDomain } from "@aws-cdk/aws-elasticsearch";
import { Alias } from "@aws-cdk/aws-kms";
import { StreamEncryption } from '@aws-cdk/aws-kinesis';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import { KinesisEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { AttributeType } from '@aws-cdk/aws-dynamodb';
import { BlockPublicAccess, Bucket, LifecycleRule, StorageClass } from '@aws-cdk/aws-s3';
import { Rule, Schedule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';


export class AdsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // UPDATE THIS SECTION WITH YOUR CREDENTIALS
    const esUserName = "elasticads";
    const esPassword = "Elastic4d$";

    //
    // CLIENT API - API GATEWAY -> LAMBDA -> ELASTIC SEARCH
    //

    const lambdaRole = new Role(this, "adstack-lambda-qldbaccess", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      roleName: "adstack-lambda-qldbaccess-role",
    });

    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaFullAccess")
    );
    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonQLDBFullAccess")
    );

    const key = Alias.fromAliasName(this, "esKey", "alias/aws/es");

    const esPolicyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["es:*"],
    });
    esPolicyStatement.addAnyPrincipal();

    const esAccessPolicy = new PolicyDocument({
      assignSids: true,
      statements: [esPolicyStatement],
    });

    const es = new CfnDomain(this, "esDomain", {
      domainName: "elasticads",
      domainEndpointOptions: {
        enforceHttps: true,
      },
      elasticsearchClusterConfig: {
        instanceCount: 1,
        dedicatedMasterEnabled: false,
      },
      elasticsearchVersion: "7.7",
      encryptionAtRestOptions: {
        enabled: true,
        kmsKeyId: key.keyId,
      },
      nodeToNodeEncryptionOptions: {
        enabled: true,
      },
      ebsOptions: {
        ebsEnabled: true,
        volumeSize: 10,
      },
      advancedSecurityOptions: {
        enabled: true,
        internalUserDatabaseEnabled: true,
        masterUserOptions: {
          masterUserName: esUserName,
          masterUserPassword: esPassword,
        },
      },
      accessPolicies: esAccessPolicy,
    });

    const clientHandler = new Function(this, "ClientHandler", {
      runtime: Runtime.NODEJS_12_X,
      code: Code.fromAsset(
        "../backend/src/AdClientAPI/.serverless/adclientapi.zip"
      ),
      handler: "handler.handler",
      role: lambdaRole,
      timeout: Duration.seconds(15),
      environment: {
        masterUserName: esUserName,
        masterUserPassword: esPassword,
        esUrl: es.attrDomainEndpoint,
      },
    });

    new CfnOutput(this, "esEndpointOutput", {
      exportName: "esEndpoint",
      value: `https://${es.attrDomainEndpoint}/_plugin/kibana`,
    });

    const clientApi = new RestApi(this, "ClientAPI", {
      restApiName: "Ads Client API",
      description: "This API allows customers to search for Ads",
    });

    const searchAdsIntegration = new LambdaIntegration(clientHandler);
    clientApi.root.addMethod("GET", searchAdsIntegration, {
      requestParameters: {
        "method.request.querystring.q": false,
      },
    });

    //
    // PUBLISHER API - API GATEWAY -> LAMBDA -> QLDB
    //

    const ledger = new CfnLedger(this, "adLedger", {
      name: "adLedger",
      permissionsMode: "ALLOW_ALL",
    });

    const QldbToKinesisRole = new Role(this, "qldbToKinesisRole", {
      roleName: "QldbToKinesisRole",
      assumedBy: new ServicePrincipal("qldb.amazonaws.com"),
    });
    QldbToKinesisRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonKinesisFullAccess")
    );

    const streamKey = Alias.fromAliasName(this, "streamKey", "alias/aws/kinesis");

    const qldbStream = new Kinesis.Stream(this, "qldbStream", {
      shardCount: 1,
      encryption: StreamEncryption.KMS,
      encryptionKey: streamKey,
      streamName: "adsStream"
    });

    new CfnStream(this, "qldbStreamConfig", {
      ledgerName: "adLedger",
      streamName: qldbStream.streamName,
      roleArn: QldbToKinesisRole.roleArn,
      inclusiveStartTime: new Date().toISOString(),
      kinesisConfiguration: {
        aggregationEnabled: true,
        streamArn: qldbStream.streamArn,
      },
    });

    // LAMBDA ROLE WITH PERMISSIONS TO WRITE TO ELASTIC SEARCH
    const processorLambdaRole = new Role(this, "adstack-lambda-es-access", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      roleName: "adstack-lambda-es-access-role",
    });

    processorLambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaFullAccess")
    );
    processorLambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonKinesisFullAccess")
    );

    // PROCESSOR LAMBDA
    const processorHandler = new Function(this, "ProcessorHandler", {
      runtime: Runtime.NODEJS_12_X,
      code: Code.fromAsset(
        "../backend/src/ESProcessor/.serverless/esprocessor.zip"
      ),
      handler: "handler.handler",
      role: processorLambdaRole,
      timeout: Duration.minutes(3),
      environment: {
        masterUserName: esUserName,
        masterUserPassword: esPassword,
        esUrl: es.attrDomainEndpoint
      },
    });

    processorHandler.addEventSource(new KinesisEventSource(qldbStream, {
      retryAttempts: 10,
      startingPosition: StartingPosition.TRIM_HORIZON,
    }));

    // DynamoDB
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY
    });

    table.addGlobalSecondaryIndex({
      indexName: "publisherId-adId-index",
      partitionKey: {
        name: "publisherId",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "adId",
        type: AttributeType.STRING
      }
    });

    // Dynamo Processor Lambda
    const dynamoProcessorRole = new Role(this, "adstack-lambda-dynamo-access", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      roleName: "adstack-lambda-dynamo-access-role",
    });

    dynamoProcessorRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaFullAccess")
    );
    dynamoProcessorRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess")
    );
    dynamoProcessorRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonKinesisFullAccess")
    );

    // PROCESSOR LAMBDA
    const dynamoProcessorHandler = new Function(this, "DynamoProcessorHandler", {
      runtime: Runtime.NODEJS_12_X,
      code: Code.fromAsset(
        "../backend/src/DynamoProcessor/.serverless/dynamoprocessor.zip"
      ),
      handler: "handler.handler",
      role: dynamoProcessorRole,
      timeout: Duration.minutes(3),
      environment: {
        tableName: table.tableName
      }
    });

    dynamoProcessorHandler.addEventSource(new KinesisEventSource(qldbStream, {
      retryAttempts: 10,
      startingPosition: StartingPosition.TRIM_HORIZON,
    }));

    const publisherHandler = new Function(this, "PublisherHandler", {
      runtime: Runtime.NODEJS_12_X,
      role: lambdaRole,
      timeout: Duration.seconds(15),
      code: Code.fromAsset(
        "../backend/src/AdPublisherAPI/.serverless/adpublisherapi.zip"
      ),
      handler: "handler.handler",
      environment: {
        ledgerName: `${ledger.name}`
      }
    });

    const readerHandler = new Function(this, "ReaderHandler", {
      runtime: Runtime.NODEJS_12_X,
      role: lambdaRole,
      timeout: Duration.seconds(15),
      code: Code.fromAsset(
        "../backend/src/AdReaderAPI/.serverless/adreaderapi.zip"
      ),
      handler: "handler.handler",
      environment: {
        ledgerName: `${ledger.name}`,
        tableName: table.tableName
      }
    });

    const api = new RestApi(this, "AdsAPI", {
      restApiName: "Ads API",
      description: "This API allows users to manage Ads",
    });

    const publisherRoot = api.root.addResource("publisher");
    const publisherResource = publisherRoot.addResource("{publisher}");
    const adRoot = publisherResource.addResource("ad");
    const adOperationsResource = adRoot.addResource("{adId}");

    // POST /publisher/{publisher}/ad
    const createAdIntegration = new LambdaIntegration(publisherHandler);
    adRoot.addMethod("POST", createAdIntegration);

    // PATCH /publisher/{publisher}/ad/{adId}
    const updateAdIntegration = new LambdaIntegration(publisherHandler);
    adOperationsResource.addMethod("PATCH", updateAdIntegration);

    // DELETE /publisher/{publisher}/ad/{adId}
    const deleteAdIntegration = new LambdaIntegration(publisherHandler);
    adOperationsResource.addMethod("DELETE", deleteAdIntegration);

    // GET /publisher/{publisher}/ad/*
    const getAllIntegration = new LambdaIntegration(readerHandler);
    adRoot.addMethod("GET", getAllIntegration);

    // GET /publisher/{publisher}/ad/{adId}?versions=true
    const getAdIntegration = new LambdaIntegration(readerHandler);
    adOperationsResource.addMethod("GET", getAdIntegration, {
      requestParameters: {
        "method.request.querystring.versions": false,
      },
    });

    //
    // OPERATIONS COMPONENTS
    //

    // Storage for Snapshots
    const snapshotBucket = new Bucket(this, "snapshotBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          enabled: true,
          transitions: [{
            storageClass: StorageClass.GLACIER,
            transitionAfter: Duration.days(90)
          }]
        }
      ]
    });

    // Role for lambda execution - permissions to export from QLDB and default permissions to write to cloudwatch
    const exportRole = new Role(this, "LambdaQLDBExportRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      roleName: "LambdaQLDBExportRole",
    });

    exportRole.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "qldb:ExportJournalToS3"
      ],
      resources: [
        `arn:aws:qldb:${this.region}:${this.account}:ledger/${ledger.name}`
      ]
    }));

    exportRole.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "logs:CreateLogStream",
        "logs:CreateLogGroup",
        "logs:PutLogEvents"
      ],
      resources: [
        "*"
      ]
    }));

    // Role for export job execution - permissions to write to S3
    const exportJobRole = new Role(this, "QLDBExportJobRole", {
      assumedBy: new ServicePrincipal("qldb.amazonaws.com"),
      roleName: "QLDBExportJobRole",
    });

    exportJobRole.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "s3:PutObjectAcl",
        "s3:PutObject"
      ],
      resources: [
        `${snapshotBucket.bucketArn}/*`
      ]
    }));

    // Snapshot Lambda
    const SnapshotHandler = new Function(this, "SnapshotHandler", {
      runtime: Runtime.NODEJS_12_X,
      code: Code.fromAsset(
        "../backend/src/PeriodicSnapshot/.serverless/opsapi.zip"
      ),
      handler: "handler.handler",
      role: exportRole,
      timeout: Duration.minutes(3),
      environment: {
        ledgerName: `${ledger.name}`,
        roleArn: exportJobRole.roleArn,
        bucketName: snapshotBucket.bucketName,
      }
    });

    // Cloudwatch Event Rule to trigger on the first day of each month
    const lambdaTarget = new LambdaFunction(SnapshotHandler);

    new Rule(this, "monthlyTrigger", {
      ruleName: "CreateQLDBSnapshot",
      enabled: true,
      schedule: Schedule.cron({
        minute: "1",
        hour: "0",
        day: "1",
        month: "*",
        year: "*"
      }),
      targets: [lambdaTarget]
    });

    // Replay DynamoDB
    const replayTable = new dynamodb.Table(this, 'ReplayTable', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY
    });

    replayTable.addGlobalSecondaryIndex({
      indexName: "publisherId-adId-index",
      partitionKey: {
        name: "publisherId",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "adId",
        type: AttributeType.STRING
      }
    });

    // replay Lambda Role
    const replayRole = new Role(this, "adstack-lambda-replay-dynamo-access", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      roleName: "adstack-lambda-replay-dynamo-access",
    });

    replayRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaFullAccess")
    );
    replayRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess")
    );
    replayRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonQLDBFullAccess")
    );

    // Replay LAMBDA
    const replayHandler = new Function(this, "ReplayHandler", {
      runtime: Runtime.NODEJS_12_X,
      code: Code.fromAsset(
        "../backend/src/ReplayAPI/.serverless/replayapi.zip"
      ),
      handler: "handler.handler",
      role: replayRole,
      timeout: Duration.minutes(3),
      environment: {
        tableName: replayTable.tableName
      }
    });

    // Replay APIs
    const replayApi = new RestApi(this, "ReplayAPI", {
      restApiName: "Ads Replay API",
      description: "This API allows operations team to Ads to another state store - dynamodb - for troubleshooting or test purposes.",
    });

    const replayIntegration = new LambdaIntegration(replayHandler);
    replayApi.root.addMethod("GET", replayIntegration, {
      requestParameters: {
        "method.request.querystring.startDateTime": false,
        "method.request.querystring.endDateTime": false,
      },
    });

    const replayEntityResource = replayApi.root.addResource("id").addResource("{id}");
    
    replayEntityResource.addMethod("GET", replayIntegration, {
      requestParameters: {
        "method.request.querystring.startDateTime": false,
        "method.request.querystring.endDateTime": false,
      },
    });
  }
}
