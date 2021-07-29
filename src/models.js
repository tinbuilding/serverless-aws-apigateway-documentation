'use strict';

const AWS_APIGATEWAY_METHOD = 'AWS::ApiGateway::Model'

function replaceModelRefs(restApiId, cfModel) {
    if (!cfModel.Properties || !cfModel.Properties.Schema || Object.keys(cfModel.Properties.Schema).length == 0) {
      return cfModel;
    }

    function replaceRefs(obj) {
        for (let key of Object.keys(obj)) {
            if (key === '$ref') {
                let match;
                if (match = /{{model:\s*([\-\w]+)}}/.exec(obj[key])) {
                    obj[key] = {
                        'Fn::Join': [
                            '/',
                            [
                                'https://apigateway.amazonaws.com/restapis',
                                restApiId,
                                'models',
                                match[1]
                            ]
                        ]
                    };
                    if (!cfModel.DependsOn) {
                        cfModel.DependsOn = new Set();
                    }
                    cfModel.DependsOn.add(match[1]+'Model');
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                replaceRefs(obj[key]);
            }
        }
    }

    replaceRefs(cfModel.Properties.Schema);
    if (cfModel.DependsOn) {
        cfModel.DependsOn = Array.from(cfModel.DependsOn);
    }
    return cfModel;
}

function splitResourcesDepends(data) {
  const initialFormat = { withDepends: {}, withoutDepends: {}, othersResources: {} }
  return Object.keys(data).reduce(({ withDepends, withoutDepends, othersResources }, resourceName) => {
      if (data[resourceName].Type === AWS_APIGATEWAY_METHOD) {
          if (!data[resourceName].DependsOn) {
              withoutDepends = { ...withoutDepends, [resourceName]: data[resourceName] }
          } else {
              withDepends = { ...withDepends, [resourceName]: data[resourceName] }
          }
      } else {
          othersResources = { ...othersResources, [resourceName]: data[resourceName] }
      }

      return { withDepends, withoutDepends, othersResources }
  }, initialFormat)
}

function preparingModelsWithoutDepends(models, SPLIT_LIMIT) {
  const keys = Object.keys(models).map(v => v);
  const length = keys.length;

  for(let i = 0; (i + SPLIT_LIMIT) < length; i++) {
    const fatherName = keys[i]
    let sonModel = models[keys[i + SPLIT_LIMIT]]
    
    sonModel.DependsOn = [fatherName]

    models[keys[i + SPLIT_LIMIT]] = sonModel
  }

  return models
}

module.exports = {
  createCfModel: function createCfModel(restApiId) {
    return function(model) {

      let cfModel = {
        Type: AWS_APIGATEWAY_METHOD,
        Properties: {
          RestApiId: restApiId,
          ContentType: model.contentType,
          Name: model.name,
          Schema: model.schema || {},
        },
      }

      if (model.description) {
        cfModel.Properties.Description = model.description
      }

      return replaceModelRefs(restApiId, cfModel)
    }
  },

  addModelDependencies: function addModelDependencies(models, resource) {
    Object.keys(models).forEach(contentType => {
      if (!models[contentType].import) {
        resource.DependsOn.add(`${models[contentType]}Model`);
      }
    });
  },

  addMethodResponses: function addMethodResponses(resource, documentation) {
    if (documentation.methodResponses) {
      if (!resource.Properties.MethodResponses) {
        resource.Properties.MethodResponses = [];
      }

      const newMethodResponses = documentation.methodResponses.map(response => {
        const statusCode = response.statusCode.toString();
        let _response = resource.Properties.MethodResponses
          .find(originalResponse => originalResponse.StatusCode.toString() === statusCode);

        if (!_response) {
          _response = {
            StatusCode: statusCode,
          };

          if (response.responseHeaders) {
            const methodResponseHeaders = {};
            response.responseHeaders.forEach(header => {
              methodResponseHeaders[`method.response.header.${header.name}`] = true
            });
            _response.ResponseParameters = methodResponseHeaders;
          }

          resource.Properties.MethodResponses.push(_response);
        }

        if (response.responseModels) {
          _response.ResponseModels = response.responseModels;
          this.addModelDependencies(_response.ResponseModels, resource);
          Object.keys(response.responseModels).forEach(model => {
            if (response.responseModels[model].import) {
              response.responseModels[model] = response.responseModels[model].import;
            }
          })
        }

        return response
      });

      documentation.methodResponses = newMethodResponses;
    }
  },

  addRequestModels: function addRequestModels(resource, documentation) {
    if (documentation.requestModels && Object.keys(documentation.requestModels).length > 0) {
      this.addModelDependencies(documentation.requestModels, resource);
      Object.keys(documentation.requestModels).forEach(model => {
        if (documentation.requestModels[model].import) {
          documentation.requestModels[model] = documentation.requestModels[model].import
        }
      });
      resource.Properties.RequestModels = documentation.requestModels;
    }
  },

  makeDependents: function makeDependents(resources, SPLIT_LIMIT) {
    const { withDepends, withoutDepends, othersResources } = splitResourcesDepends(resources);
    const newsModelsWithDependsOn = preparingModelsWithoutDepends(withoutDepends, SPLIT_LIMIT);

    return { ...newsModelsWithDependsOn, ...withDepends, ...othersResources };
  }
};
