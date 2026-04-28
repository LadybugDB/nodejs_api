cmake_minimum_required(VERSION 3.15)
project(lbugjs LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_definitions(-DNAPI_VERSION=6)
add_definitions(-DNODE_RUNTIME=node)
add_definitions(-DBUILDING_NODE_EXTENSION)

set(LBUG_SOURCE_DIR "" CACHE PATH "Path to the Ladybug source tree used for standalone Node.js builds")
set(LBUG_BUILD_DIR "" CACHE PATH "Path to the Ladybug build tree used for standalone Node.js builds")
set(LBUG_NODEJS_EXTRA_LINK_LIBS "" CACHE STRING "Additional link libraries for standalone Node.js builds against a precompiled liblbug")

function(lbug_nodejs_set_default_dir out_var suffix)
  foreach(base_dir IN ITEMS "${LBUG_SOURCE_DIR}" "${CMAKE_SOURCE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/../.." "${CMAKE_CURRENT_SOURCE_DIR}/../ladybug")
    if(base_dir AND EXISTS "${base_dir}/${suffix}")
      set(${out_var} "${base_dir}/${suffix}" PARENT_SCOPE)
      return()
    endif()
  endforeach()
  set(${out_var} "" PARENT_SCOPE)
endfunction()

# If on Windows use npx.cmd instead of npx
if(WIN32)
  set(NPX_CMD npx.cmd)
else()
  set(NPX_CMD npx)
endif()

execute_process(
  COMMAND ${NPX_CMD} cmake-js print-cmakejs-include
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE CMAKE_JS_INC
  ERROR_QUIET
)
execute_process(
  COMMAND ${NPX_CMD} cmake-js print-cmakejs-lib
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE CMAKE_JS_LIB
  ERROR_QUIET
)
execute_process(
  COMMAND ${NPX_CMD} cmake-js print-cmakejs-src
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE CMAKE_JS_SRC
  ERROR_QUIET
)
execute_process(
  COMMAND node -p "process.config.variables.node_prefix || ''"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_PREFIX
  ERROR_QUIET
)

# Without this windows breaks with:  Invalid character escape '\P'.
string(REPLACE "\\" "/" CMAKE_JS_INC "${CMAKE_JS_INC}")
string(REPLACE "\\" "/" CMAKE_JS_LIB "${CMAKE_JS_LIB}")
string(REPLACE "\\" "/" CMAKE_JS_SRC "${CMAKE_JS_SRC}")

# cmake-js v8 pollutes stdout with log messages (INFO, WARN) before printing
# the actual value. The actual value is always the LAST line of output (from
# console.info() in bin/cmake-js). Some log messages span multiple lines (e.g.
# find-visualstudio: "INFO ... found at:\n\"C:/path\"\nrun with --verbose"),
# so we can't simply strip lines starting with INFO/WARN.
#
# Strategy: strip trailing whitespace, extract only the last line (everything
# after the final \n), then clear any remaining value that isn't a valid path.
# On Linux, when cmake-js returns an empty value, the only output is the INFO
# log line itself (single line, no \n), which must also be cleared.
string(STRIP "${CMAKE_JS_INC}" CMAKE_JS_INC)
string(STRIP "${CMAKE_JS_LIB}" CMAKE_JS_LIB)
string(STRIP "${CMAKE_JS_SRC}" CMAKE_JS_SRC)
string(STRIP "${NODE_PREFIX}" NODE_PREFIX)
# Extract last line: remove everything up to and including the last newline.
string(REGEX REPLACE ".*\n" "" CMAKE_JS_INC "${CMAKE_JS_INC}")
string(REGEX REPLACE ".*\n" "" CMAKE_JS_LIB "${CMAKE_JS_LIB}")
string(REGEX REPLACE ".*\n" "" CMAKE_JS_SRC "${CMAKE_JS_SRC}")
# Clear any value that is not a valid path (e.g. a leftover single-line INFO/WARN log).
# Valid cmake-js values are absolute paths starting with / or a drive letter (e.g. C:/).
if(NOT CMAKE_JS_INC MATCHES "^(/|[A-Za-z]:)")
  set(CMAKE_JS_INC "")
endif()
if(NOT CMAKE_JS_LIB MATCHES "^(/|[A-Za-z]:)")
  set(CMAKE_JS_LIB "")
endif()
if(NOT CMAKE_JS_SRC MATCHES "^(/|[A-Za-z]:)")
  set(CMAKE_JS_SRC "")
endif()
if(NOT CMAKE_JS_INC AND NODE_PREFIX MATCHES "^(/|[A-Za-z]:)")
  set(CMAKE_JS_INC "${NODE_PREFIX}/include/node")
endif()
if(WIN32 AND NOT CMAKE_JS_LIB AND NODE_PREFIX MATCHES "^(/|[A-Za-z]:)")
  set(CMAKE_JS_LIB "${NODE_PREFIX}/lib/node.lib")
endif()

# Print CMAKE_JS variables
message(STATUS "CMake.js configurations: LIB=${CMAKE_JS_LIB}, INC=${CMAKE_JS_INC}, SRC=${CMAKE_JS_SRC}")

get_filename_component(NODE_ADDON_API_INCLUDE_PATH ./node_modules/node-addon-api ABSOLUTE)

include_directories(${CMAKE_JS_INC})
include_directories(${NODE_ADDON_API_INCLUDE_PATH})

file(GLOB CPP_SOURCE_FILES ./src_cpp/*)
file(GLOB JS_SOURCE_FILES 
    ./src_js/*.js
    ./src_js/*.mjs
    ./src_js/*.d.ts
)
# Copy all JS/TS files to build directory
file(COPY ${JS_SOURCE_FILES} DESTINATION  "${CMAKE_CURRENT_SOURCE_DIR}/build")

set(NODEJS_LBUG_LINK_DEPS "")
if(NOT TARGET lbug)
  if(NOT LBUG_NODEJS_USE_PRECOMPILED_LIB)
    message(FATAL_ERROR "The Node.js addon requires the lbug target or LBUG_NODEJS_USE_PRECOMPILED_LIB=TRUE.")
  endif()
  if(NOT LBUG_NODEJS_PRECOMPILED_LIB_PATH)
    message(FATAL_ERROR "LBUG_NODEJS_PRECOMPILED_LIB_PATH must point to a precompiled static liblbug archive.")
  endif()
  if(NOT EXISTS "${LBUG_NODEJS_PRECOMPILED_LIB_PATH}")
    message(FATAL_ERROR "Precompiled liblbug archive not found: ${LBUG_NODEJS_PRECOMPILED_LIB_PATH}")
  endif()

  lbug_nodejs_set_default_dir(LBUG_NODEJS_SOURCE_INCLUDE_DIR "src/include")
  set(LBUG_NODEJS_BUILD_INCLUDE_DIR "")
  if(LBUG_BUILD_DIR AND EXISTS "${LBUG_BUILD_DIR}/src/include")
    set(LBUG_NODEJS_BUILD_INCLUDE_DIR "${LBUG_BUILD_DIR}/src/include")
  elseif(LBUG_SOURCE_DIR AND EXISTS "${LBUG_SOURCE_DIR}/build/release/src/include")
    set(LBUG_NODEJS_BUILD_INCLUDE_DIR "${LBUG_SOURCE_DIR}/build/release/src/include")
  elseif(EXISTS "${CMAKE_BINARY_DIR}/src/include")
    set(LBUG_NODEJS_BUILD_INCLUDE_DIR "${CMAKE_BINARY_DIR}/src/include")
  elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../build/release/src/include")
    set(LBUG_NODEJS_BUILD_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../build/release/src/include")
  elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../ladybug/build/release/src/include")
    set(LBUG_NODEJS_BUILD_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../ladybug/build/release/src/include")
  endif()

  if(NOT LBUG_NODEJS_SOURCE_INCLUDE_DIR)
    message(FATAL_ERROR "Could not determine the Ladybug source include directory. Set LBUG_SOURCE_DIR to a Ladybug checkout.")
  endif()
  if(NOT LBUG_NODEJS_BUILD_INCLUDE_DIR)
    message(FATAL_ERROR "Could not determine the Ladybug build include directory. Set LBUG_BUILD_DIR or LBUG_SOURCE_DIR to a built Ladybug tree.")
  endif()

  add_library(lbug STATIC IMPORTED GLOBAL)
  set_target_properties(lbug PROPERTIES IMPORTED_LOCATION "${LBUG_NODEJS_PRECOMPILED_LIB_PATH}")
  target_include_directories(lbug INTERFACE
    "${LBUG_NODEJS_SOURCE_INCLUDE_DIR}"
    "${LBUG_NODEJS_BUILD_INCLUDE_DIR}")
  if(WIN32)
    target_compile_definitions(lbug INTERFACE LBUG_STATIC_DEFINE)
  endif()
  if(TARGET lbug_link_deps)
    set(NODEJS_LBUG_LINK_DEPS "$<LINK_ONLY:lbug_link_deps>")
  endif()
endif()

add_library(lbugjs SHARED ${CPP_SOURCE_FILES})
if(CMAKE_JS_SRC)
  target_sources(lbugjs PRIVATE "${CMAKE_JS_SRC}")
endif()
set_target_properties(lbugjs PROPERTIES PREFIX "" SUFFIX ".node")
set_target_properties(lbugjs
  PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build")
if(APPLE)
  target_link_options(lbugjs PRIVATE -undefined dynamic_lookup)
else()
  target_link_options(lbugjs PRIVATE -Wl,--export-dynamic)
endif()
target_link_libraries(lbugjs PRIVATE lbug ${NODEJS_LBUG_LINK_DEPS} ${CMAKE_JS_LIB})
if(LBUG_NODEJS_EXTRA_LINK_LIBS)
  target_link_libraries(lbugjs PRIVATE ${LBUG_NODEJS_EXTRA_LINK_LIBS})
endif()
