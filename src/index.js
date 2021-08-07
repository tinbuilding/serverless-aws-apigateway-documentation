'use strict';
const documentation = require('./documentation');
const models = require('./models');
const swagger = require('./swagger');
const fs = require('fs');
const downloadDocumentation = require('./downloadDocumentation');

const SPLIT_NUMBER_DEFAULT = 10
const SPLIT_FEATURE_DEFAULT = false

class ServerlessAWSDocumentation {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = 'aws';
    this.fs = fs;

    Object.assign(this, models);
    Object.assign(this, swagger);
    Object.assign(this, documentation());
    Object.assign(this, downloadDocumentation);

    this.customVars = this.serverless.variables.service.custom;
    const naming = this.serverless.providers.aws.naming;
    this.getMethodLogicalId = naming.getMethodLogicalId.bind(naming);
    this.normalizePath = naming.normalizePath.bind(naming);

    this._beforeDeploy = this.beforeDeploy.bind(this)
    this._afterDeploy = this.afterDeploy.bind(this)
    this._download = downloadDocumentation.downloadDocumentation.bind(this)

    this.hooks = {
      'before:package:finalize': this._beforeDeploy,
      'after:deploy:deploy': this._afterDeploy,
      'downloadDocumentation:downloadDocumentation': this._download
    };

    this.documentationParts = [];

    this.commands = {
        downloadDocumentation: {
            usage: 'Download API Gateway documentation from AWS',
            lifecycleEvents: [
              'downloadDocumentation',
            ],
            options: {
                outputFileName: {
                  required: true,
                  type: 'string'
                },
                extensions: {
                    required: false,
                    type: 'multiple'
                },
            },
        }
    };

    //validation rules for 'documentation' property on 'http' event from 'aws' provider
    const docConfigSchema = {
      type: 'object',
      definitions: {
        models: {
          type: 'object',
          patternProperties: { '*/*': { type: 'string' } }
        },
        body: {
          type: 'object',
          properties: { description: { type: 'string' } }
        },
        arrayOfProps: {
          type: 'array',
          items: [
            {
              type: 'object',
              properties: { name: { type: 'string' }, description: { type: 'string' } },
              required: [ 'name' ]
            }
          ]
        }
      },
      properties: {
        documentation: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            description: { type: 'string' },
            tags: { type: 'array', items: [ { type: 'string' } ] },
            requestBody: { "'$ref'": '#/definitions/body' },
            requestHeaders: { "'$ref'": '#/definitions/arrayOfProps' },
            queryParams: { "'$ref'": '#/definitions/arrayOfProps' },
            pathParams: { "'$ref'": '#/definitions/arrayOfProps' },
            requestModels: { "'$ref'": '#/definitions/models' },
            methodResponses: {
              type: 'array',
              items: [
                {
                  type: 'object',
                  properties: {
                    statusCode: { type: 'string' },
                    responseBody: { "'$ref'": '#/definitions/body' },
                    responseHeaders: { "'$ref'": '#/definitions/arrayOfProps' },
                    responseModels: { "'$ref'": '#/definitions/models' }
                  },
                  required: [ 'statusCode' ]
                }
              ]
            }
          }
        }
      }
    };

    //create schema for 'documentation' property
    this.serverless.configSchemaHandler.defineFunctionEventProperties('aws', 'http', docConfigSchema);
  }

  beforeDeploy() {
    this.customVars = this.serverless.variables.service.custom;
    if (!(this.customVars && this.customVars.documentation)) return;

    let SPLIT_MODELS_LIMIT = SPLIT_NUMBER_DEFAULT;
    let SPLIT_FEATURE = SPLIT_FEATURE_DEFAULT;

    if (this.serverless.variables.service.provider.documentation) {
      SPLIT_MODELS_LIMIT = this.serverless.variables.service.provider.documentation.splitModelsLimit || SPLIT_MODELS_LIMIT;
      SPLIT_FEATURE = this.serverless.variables.service.provider.documentation.splitModels || SPLIT_FEATURE;
    }

    if (this.customVars.documentation.swagger) {
      // Handle references to models
      this.replaceSwaggerDefinitions(this.customVars.documentation.definitions)
      //Map swagger into documentation models
      const swaggerDefs = this.customVars.documentation.definitions
      if (swaggerDefs) {
        const swaggerModels = Object.keys(swaggerDefs).map(definitionName => {
          return {
            name: definitionName,
            description: swaggerDefs[definitionName].description,
            contentType: 'application/json',
            schema: swaggerDefs[definitionName]
          }
        })
        this.customVars.documentation.models = swaggerModels
      } else {
        this.customVars.documentation.models = []
      }

      //Find http events and map the swagger across
      this.serverless.service.getAllFunctions().forEach(functionName => {
        const func = this.serverless.service.getFunction(functionName)
        if (func.events) {
          func.events.forEach(event => {
            if (event.http) {
              // look up the path in the swagger
              const path = this.customVars.documentation.paths['/' + event.http.path]
              if (path) {
                const method = path[event.http.method]
                const methodDoc = {'requestHeaders': [], 'pathParams': [], 'queryParams': [],
                  'requestModels': {}}
                if ( method.parameters ) {
                  method.parameters.forEach(param => {
                    if (param.in === 'header') {
                      methodDoc['requestHeaders'].push({
                        name: param.name,
                        description: param.description,
                        required: param.required
                      })
                    } else if (param.in === 'path') {
                      methodDoc['pathParams'].push({
                        name: param.name,
                        description: param.description,
                        required: param.required
                      })
                    } else if (param.in === 'query') {
                      methodDoc['queryParams'].push({
                        name: param.name,
                        description: param.description,
                        required: param.required
                      })
                    } else if (param.in === 'body') {
                      methodDoc['requestModels']['application/json'] =
                        this.extractModel(param, this.customVars.documentation.models);
                    }
                  })
                }

                if ( method.responses ) {
                  methodDoc['methodResponses'] = []
                  Object.keys(method.responses).map(statusCode => {
                    const response = method.responses[statusCode];
                    const methodResponse = {
                      statusCode: ""+statusCode,
                    };

                    if ( response.schema ) {
                      const responseModels = {};
                      responseModels['application/json'] =
                        this.extractModel(response, this.customVars.documentation.models);
                      methodResponse['responseModels'] = responseModels;
                    }
                    methodDoc['methodResponses'].push(methodResponse);
                  });
                }

                event.http.documentation = methodDoc
              }
            }
          })
        }
      })
    }

    this.cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;

    // The default rest API reference
    let restApiId = {
      Ref: 'ApiGatewayRestApi',
    };

    // Use the provider API gateway if one has been provided.
    if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
      restApiId = this.serverless.service.provider.apiGateway.restApiId
    }

    if (this.customVars.documentation.models) {
      const cfModelCreator = this.createCfModel(restApiId);

      // Add model resources
      const models = this.customVars.documentation.models.map(cfModelCreator)
        .reduce((modelObj, model) => {
          modelObj[`${model.Properties.Name}Model`] = model;
          return modelObj;
        }, {});
      Object.assign(this.cfTemplate.Resources, models);
    }

    // Add models to method resources
    this.serverless.service.getAllFunctions().forEach(functionName => {
      const func = this.serverless.service.getFunction(functionName);
      func.events.forEach(this.updateCfTemplateFromHttp.bind(this));
    });

    // Add documentation parts for HTTP endpoints
    this.updateCfTemplateWithEndpoints(restApiId);

    // Preventing "too much request" error in cloudFormation
    if (SPLIT_FEATURE) {
      this.cfTemplate.Resources = this.makeDependents(this.cfTemplate.Resources, SPLIT_MODELS_LIMIT);
    }

    // Add models
    this.cfTemplate.Outputs.AwsDocApiId = {
      Description: 'API ID',
      Value: restApiId,
    };
  }

  afterDeploy() {
    if (!this.customVars.documentation) return;
    const stackName = this.serverless.providers.aws.naming.getStackName(this.options.stage);
    return this.serverless.providers.aws.request('CloudFormation', 'describeStacks', { StackName: stackName },
      this.options.stage,
      this.options.region
    ).then(this._buildDocumentation.bind(this))
    .catch(err => {
      if (err === 'documentation version already exists, skipping upload') {
        return Promise.resolve();
      }

      return Promise.reject(err);
    });
  }

}

module.exports = ServerlessAWSDocumentation;
