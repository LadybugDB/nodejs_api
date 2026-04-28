#pragma once

#include "binder/bound_statement_result.h"
#include "main/lbug.h"
#include "node_util.h"
#include "planner/operator/logical_plan.h"
#include "processor/result/factorized_table.h"
#include <atomic>
#include <memory>
#include <napi.h>

using namespace lbug::processor;
using namespace lbug::main;

class NodeQueryResult : public Napi::ObjectWrap<NodeQueryResult> {
    friend class NodeQueryResultGetNextAsyncWorker;
    friend class NodeQueryResultGetColumnMetadataAsyncWorker;
    friend class NodeQueryResultGetNextQueryResultAsyncWorker;
    friend class NodeQueryResultGetQuerySummaryAsyncWorker;

public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Object NewInstance(Napi::Env env, std::unique_ptr<QueryResult> queryResult,
        std::shared_ptr<Connection> connection, std::shared_ptr<Database> database);
    explicit NodeQueryResult(const Napi::CallbackInfo& info);
    void AdoptQueryResult(std::unique_ptr<QueryResult> queryResult,
        std::shared_ptr<Connection> connection, std::shared_ptr<Database> database);
    std::unique_ptr<QueryResult> DetachNextQueryResult();
    ~NodeQueryResult() override;

private:
    void ResetIterator(const Napi::CallbackInfo& info);
    Napi::Value HasNext(const Napi::CallbackInfo& info);
    Napi::Value HasNextQueryResult(const Napi::CallbackInfo& info);
    Napi::Value GetNextQueryResultAsync(const Napi::CallbackInfo& info);
    Napi::Value GetNextQueryResultSync(const Napi::CallbackInfo& info);
    Napi::Value GetNumTuples(const Napi::CallbackInfo& info);
    Napi::Value GetNextAsync(const Napi::CallbackInfo& info);
    Napi::Value GetNextSync(const Napi::CallbackInfo& info);
    Napi::Value GetColumnDataTypesAsync(const Napi::CallbackInfo& info);
    Napi::Value GetColumnDataTypesSync(const Napi::CallbackInfo& info);
    Napi::Value GetColumnNamesAsync(const Napi::CallbackInfo& info);
    Napi::Value GetColumnNamesSync(const Napi::CallbackInfo& info);
    Napi::Value GetQuerySummarySync(const Napi::CallbackInfo& info);
    Napi::Value GetQuerySummaryAsync(const Napi::CallbackInfo& info);
    void PopulateColumnNames();
    void Close(const Napi::CallbackInfo& info);
    void Close();
    QueryResult& GetQueryResult() const;
    void AcquireAsyncUse();
    void ReleaseAsyncUse();
    void ThrowIfAsyncOperationInFlight(const char* operation) const;

private:
    static Napi::FunctionReference constructor;
    std::unique_ptr<QueryResult> ownedQueryResult = nullptr;
    std::shared_ptr<Connection> connection = nullptr;
    std::shared_ptr<Database> database = nullptr;
    std::unique_ptr<std::vector<std::string>> columnNames = nullptr;
    std::atomic<uint32_t> activeAsyncUses = 0;
};

enum GetColumnMetadataType { DATA_TYPE, NAME };

class NodeQueryResultGetColumnMetadataAsyncWorker : public Napi::AsyncWorker {
public:
    NodeQueryResultGetColumnMetadataAsyncWorker(Napi::Function& callback,
        NodeQueryResult* nodeQueryResult, GetColumnMetadataType type)
        : AsyncWorker(callback), nodeQueryResult(nodeQueryResult), type(type) {
        nodeQueryResult->AcquireAsyncUse();
        nodeQueryResult->Ref();
    }

    ~NodeQueryResultGetColumnMetadataAsyncWorker() override = default;

    inline void Execute() override {
        try {
            if (type == GetColumnMetadataType::DATA_TYPE) {
                auto columnDataTypes = nodeQueryResult->GetQueryResult().getColumnDataTypes();
                result = std::vector<std::string>(columnDataTypes.size());
                for (auto i = 0u; i < columnDataTypes.size(); ++i) {
                    result[i] = columnDataTypes[i].toString();
                }
            } else {
                nodeQueryResult->PopulateColumnNames();
                result = *nodeQueryResult->columnNames;
            }
        } catch (const std::exception& exc) {
            SetError(std::string(exc.what()));
        }
    }

    inline void OnOK() override {
        auto env = Env();
        Napi::Array nodeResult = Napi::Array::New(env, result.size());
        for (auto i = 0u; i < result.size(); ++i) {
            nodeResult.Set(i, result[i]);
        }
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({env.Null(), nodeResult});
    }

    inline void OnError(Napi::Error const& error) override {
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({error.Value()});
    }

private:
    NodeQueryResult* nodeQueryResult;
    GetColumnMetadataType type;
    std::vector<std::string> result;
};

class NodeQueryResultGetNextAsyncWorker : public Napi::AsyncWorker {
public:
    NodeQueryResultGetNextAsyncWorker(Napi::Function& callback, NodeQueryResult* nodeQueryResult)
        : AsyncWorker(callback), nodeQueryResult(nodeQueryResult) {
        nodeQueryResult->AcquireAsyncUse();
        nodeQueryResult->Ref();
    }

    ~NodeQueryResultGetNextAsyncWorker() override = default;

    inline void Execute() override {
        try {
            auto& queryResult = nodeQueryResult->GetQueryResult();
            if (!queryResult.hasNext()) {
                cppTuple.reset();
            }
            cppTuple = queryResult.getNext();
        } catch (const std::exception& exc) {
            SetError(std::string(exc.what()));
        }
    }

    inline void OnOK() override {
        auto env = Env();
        if (cppTuple == nullptr) {
            nodeQueryResult->ReleaseAsyncUse();
            nodeQueryResult->Unref();
            Callback().Call({env.Null(), env.Undefined()});
            return;
        }
        Napi::Object nodeTuple = Napi::Object::New(env);
        try {
            auto columnNames = nodeQueryResult->GetQueryResult().getColumnNames();
            for (auto i = 0u; i < cppTuple->len(); ++i) {
                Napi::Value value = Util::ConvertToNapiObject(*cppTuple->getValue(i), env);
                nodeTuple.Set(columnNames[i], value);
            }
        } catch (const std::exception& exc) {
            auto napiError = Napi::Error::New(env, exc.what());
            nodeQueryResult->ReleaseAsyncUse();
            nodeQueryResult->Unref();
            Callback().Call({napiError.Value(), env.Undefined()});
            return;
        }
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({env.Null(), nodeTuple});
    }

    inline void OnError(Napi::Error const& error) override {
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({error.Value()});
    }

private:
    NodeQueryResult* nodeQueryResult;
    std::shared_ptr<FlatTuple> cppTuple;
};

class NodeQueryResultGetNextQueryResultAsyncWorker : public Napi::AsyncWorker {
public:
    NodeQueryResultGetNextQueryResultAsyncWorker(
        Napi::Function& callback, NodeQueryResult* currentQueryResult)
        : AsyncWorker(callback), currQueryResult(currentQueryResult) {
        currQueryResult->AcquireAsyncUse();
        currQueryResult->Ref();
    }

    ~NodeQueryResultGetNextQueryResultAsyncWorker() override = default;

    void Execute() override {
        try {
            nextOwnedResult = currQueryResult->DetachNextQueryResult();
            if (nextOwnedResult == nullptr) {
                return;
            }
            if (!nextOwnedResult->isSuccess()) {
                SetError(nextOwnedResult->getErrorMessage());
            }
        } catch (const std::exception& exc) {
            SetError(std::string(exc.what()));
        }
    }

    void OnOK() override {
        auto env = Env();
        currQueryResult->ReleaseAsyncUse();
        currQueryResult->Unref();
        if (nextOwnedResult == nullptr) {
            Callback().Call({env.Null(), env.Undefined()});
            return;
        }
        Callback().Call({env.Null(), NodeQueryResult::NewInstance(env, std::move(nextOwnedResult),
            currQueryResult->connection, currQueryResult->database)});
    }

    void OnError(Napi::Error const& error) override {
        currQueryResult->ReleaseAsyncUse();
        currQueryResult->Unref();
        Callback().Call({error.Value()});
    }

private:
    NodeQueryResult* currQueryResult;
    std::unique_ptr<QueryResult> nextOwnedResult;
};

class NodeQueryResultGetQuerySummaryAsyncWorker : public Napi::AsyncWorker {
public:
    NodeQueryResultGetQuerySummaryAsyncWorker(Napi::Function& callback,
        NodeQueryResult* nodeQueryResult)
        : AsyncWorker(callback), nodeQueryResult(nodeQueryResult) {
        nodeQueryResult->AcquireAsyncUse();
        nodeQueryResult->Ref();
    }

    ~NodeQueryResultGetQuerySummaryAsyncWorker() override = default;

    inline void Execute() override {
        try {
            auto querySummary = nodeQueryResult->GetQueryResult().getQuerySummary();
            result["compilingTime"] = querySummary->getCompilingTime();
            result["executionTime"] = querySummary->getExecutionTime();
        } catch (const std::exception& exc) {
            SetError(std::string(exc.what()));
        }
    }

    inline void OnOK() override {
        auto env = Env();
        Napi::Object nodeResult = Napi::Object::New(env);
        for (const auto& [key, value] : result) {
            nodeResult.Set(key, Napi::Number::New(env, value));
        }
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({env.Null(), nodeResult});
    }

    inline void OnError(Napi::Error const& error) override {
        nodeQueryResult->ReleaseAsyncUse();
        nodeQueryResult->Unref();
        Callback().Call({error.Value()});
    }

private:
    NodeQueryResult* nodeQueryResult;
    std::unordered_map<std::string, double> result;
};
