#include "include/node_query_result.h"

#include <stdexcept>
#include <thread>

#include "include/node_util.h"
#include "main/lbug.h"

using namespace lbug::main;

Napi::FunctionReference NodeQueryResult::constructor;

Napi::Object NodeQueryResult::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    Napi::Function t = DefineClass(env, "NodeQueryResult",
        {InstanceMethod("resetIterator", &NodeQueryResult::ResetIterator),
            InstanceMethod("hasNext", &NodeQueryResult::HasNext),
            InstanceMethod("hasNextQueryResult", &NodeQueryResult::HasNextQueryResult),
            InstanceMethod("getNextQueryResultAsync", &NodeQueryResult::GetNextQueryResultAsync),
            InstanceMethod("getNextQueryResultSync", &NodeQueryResult::GetNextQueryResultSync),
            InstanceMethod("getNumTuples", &NodeQueryResult::GetNumTuples),
            InstanceMethod("getNextSync", &NodeQueryResult::GetNextSync),
            InstanceMethod("getNextAsync", &NodeQueryResult::GetNextAsync),
            InstanceMethod("getColumnDataTypesAsync", &NodeQueryResult::GetColumnDataTypesAsync),
            InstanceMethod("getColumnDataTypesSync", &NodeQueryResult::GetColumnDataTypesSync),
            InstanceMethod("getColumnNamesAsync", &NodeQueryResult::GetColumnNamesAsync),
            InstanceMethod("getColumnNamesSync", &NodeQueryResult::GetColumnNamesSync),
            InstanceMethod("getQuerySummaryAsync", &NodeQueryResult::GetQuerySummaryAsync),
            InstanceMethod("getQuerySummarySync", &NodeQueryResult::GetQuerySummarySync),
            InstanceMethod("close", &NodeQueryResult::Close)});

    constructor = Napi::Persistent(t);
    constructor.SuppressDestruct();
    exports.Set("NodeQueryResult", t);
    return exports;
}

Napi::Object NodeQueryResult::NewInstance(
    Napi::Env /*env*/, std::unique_ptr<QueryResult> queryResult,
    std::shared_ptr<Connection> connection, std::shared_ptr<Database> database) {
    auto obj = constructor.New({});
    auto* nodeQueryResult = Napi::ObjectWrap<NodeQueryResult>::Unwrap(obj);
    nodeQueryResult->AdoptQueryResult(
        std::move(queryResult), std::move(connection), std::move(database));
    return obj;
}

NodeQueryResult::NodeQueryResult(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NodeQueryResult>(info) {}

NodeQueryResult::~NodeQueryResult() {
    this->Close();
}

void NodeQueryResult::AdoptQueryResult(
        std::unique_ptr<QueryResult> queryResult, std::shared_ptr<Connection> connection,
        std::shared_ptr<Database> database) {
    ThrowIfAsyncOperationInFlight("replace");
    columnNames.reset();
    ownedQueryResult = std::move(queryResult);
    this->connection = std::move(connection);
    this->database = std::move(database);
}

std::unique_ptr<QueryResult> NodeQueryResult::DetachNextQueryResult() {
    if (ownedQueryResult == nullptr) {
        return nullptr;
    }
    return ownedQueryResult->moveNextResult();
}

QueryResult& NodeQueryResult::GetQueryResult() const {
    if (ownedQueryResult == nullptr) {
        throw std::runtime_error("Query result is closed.");
    }
    return *ownedQueryResult;
}

void NodeQueryResult::AcquireAsyncUse() {
    activeAsyncUses.fetch_add(1, std::memory_order_relaxed);
}

void NodeQueryResult::ReleaseAsyncUse() {
    activeAsyncUses.fetch_sub(1, std::memory_order_relaxed);
}

void NodeQueryResult::ThrowIfAsyncOperationInFlight(const char* operation) const {
    if (activeAsyncUses.load(std::memory_order_acquire) != 0) {
        throw std::runtime_error(std::string("Cannot ") + operation +
                                 " QueryResult while an async operation is in flight.");
    }
}

void NodeQueryResult::ResetIterator(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        GetQueryResult().resetIterator();
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
}

Napi::Value NodeQueryResult::HasNext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        return Napi::Boolean::New(env, GetQueryResult().hasNext());
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::HasNextQueryResult(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        return Napi::Boolean::New(env, GetQueryResult().hasNextQueryResult());
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetNextQueryResultAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    auto callback = info[0].As<Napi::Function>();
    auto* asyncWorker = new NodeQueryResultGetNextQueryResultAsyncWorker(callback, this);
    asyncWorker->Queue();
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetNextQueryResultSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        auto nextOwnedResult = DetachNextQueryResult();
        if (nextOwnedResult == nullptr) {
            return env.Undefined();
        }
        if (!nextOwnedResult->isSuccess()) {
            Napi::Error::New(env, nextOwnedResult->getErrorMessage())
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        return NewInstance(env, std::move(nextOwnedResult), connection, database);
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetNumTuples(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        return Napi::Number::New(env, GetQueryResult().getNumTuples());
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetNextAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    auto callback = info[0].As<Napi::Function>();
    auto* asyncWorker = new NodeQueryResultGetNextAsyncWorker(callback, this);
    asyncWorker->Queue();
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetNextSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        auto& queryResult = GetQueryResult();
        if (!queryResult.hasNext()) {
            return env.Null();
        }
        auto cppTuple = queryResult.getNext();
        Napi::Object nodeTuple = Napi::Object::New(env);
        PopulateColumnNames();
        for (auto i = 0u; i < cppTuple->len(); ++i) {
            Napi::Value value = Util::ConvertToNapiObject(*cppTuple->getValue(i), env);
            nodeTuple.Set(columnNames->at(i), value);
        }
        return nodeTuple;
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

Napi::Value NodeQueryResult::GetColumnDataTypesAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    auto callback = info[0].As<Napi::Function>();
    auto* asyncWorker = new NodeQueryResultGetColumnMetadataAsyncWorker(callback, this,
        GetColumnMetadataType::DATA_TYPE);
    asyncWorker->Queue();
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetColumnDataTypesSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        auto columnDataTypes = GetQueryResult().getColumnDataTypes();
        Napi::Array nodeColumnDataTypes = Napi::Array::New(env, columnDataTypes.size());
        for (auto i = 0u; i < columnDataTypes.size(); ++i) {
            nodeColumnDataTypes.Set(i, Napi::String::New(env, columnDataTypes[i].toString()));
        }
        return nodeColumnDataTypes;
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

Napi::Value NodeQueryResult::GetColumnNamesAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    auto callback = info[0].As<Napi::Function>();
    auto* asyncWorker = new NodeQueryResultGetColumnMetadataAsyncWorker(callback, this,
        GetColumnMetadataType::NAME);
    asyncWorker->Queue();
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetColumnNamesSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    PopulateColumnNames();
    try {
        Napi::Array nodeColumnNames = Napi::Array::New(env, columnNames->size());
        for (auto i = 0u; i < columnNames->size(); ++i) {
            nodeColumnNames.Set(i, Napi::String::New(env, columnNames->at(i)));
        }
        return nodeColumnNames;
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

void NodeQueryResult::PopulateColumnNames() {
    if (this->columnNames != nullptr) {
        return;
    }
    this->columnNames = std::make_unique<std::vector<std::string>>(GetQueryResult().getColumnNames());
}

Napi::Value NodeQueryResult::GetQuerySummaryAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    auto callback = info[0].As<Napi::Function>();
    auto* asyncWorker = new NodeQueryResultGetQuerySummaryAsyncWorker(callback, this);
    asyncWorker->Queue();
    return info.Env().Undefined();
}

Napi::Value NodeQueryResult::GetQuerySummarySync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        Napi::Object summary = Napi::Object::New(env);
        auto cppSummary = GetQueryResult().getQuerySummary();
        summary.Set("compilingTime", Napi::Number::New(env, cppSummary->getCompilingTime()));
        summary.Set("executionTime", Napi::Number::New(env, cppSummary->getExecutionTime()));
        return summary;
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

void NodeQueryResult::Close(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);
    try {
        ThrowIfAsyncOperationInFlight("close");
        this->Close();
    } catch (const std::exception& exc) {
        Napi::Error::New(env, std::string(exc.what())).ThrowAsJavaScriptException();
    }
}

void NodeQueryResult::Close() {
    columnNames.reset();
    ownedQueryResult.reset();
    connection.reset();
    database.reset();
}
