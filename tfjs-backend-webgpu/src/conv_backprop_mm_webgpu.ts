/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {backend_util, util} from '@tensorflow/tfjs-core';
import {typeSnippet} from './activation_util';
import {makeMatMulPackedVec4Source} from './matmul_packed_vec4_webgpu';
import {makeMatMulPackedSource} from './matmul_packed_webgpu';
import {WebGPUProgram} from './webgpu_program';
import {computeDispatch, computeWorkGroupSizeForConv2d, computeWorkPerThreadForConv2d} from './webgpu_util';

function conv2dTransposeCommonSnippet(innerElementSize = 4) {
  const getWSnippet = (innerElementSize: number) => {
    switch (innerElementSize) {
      case 1:
        return 'return W[getIndexFromCoords4D(coord, uniforms.wShape)];';
      case 4:
        return `
            let coord1 = vec4<i32>(coordX, coordY, col + 1, rowInner);
            let coord2 = vec4<i32>(coordX, coordY, col + 2, rowInner);
            let coord3 = vec4<i32>(coordX, coordY, col + 3, rowInner);
            let v0 = W[getIndexFromCoords4D(coord, uniforms.wShape)];
            let v1 = W[getIndexFromCoords4D(coord1, uniforms.wShape)];
            let v2 = W[getIndexFromCoords4D(coord2, uniforms.wShape)];
            let v3 = W[getIndexFromCoords4D(coord3, uniforms.wShape)];
            return vec4<f32>(v0, v1, v2, v3);
            `;
      default:
        throw new Error(
            `innerElementSize ${innerElementSize} is not supported.`);
    }
  };

  const readASnippet = `
      let outRow = row / uniforms.outShape[2];
      let outCol = row % uniforms.outShape[2];

      let WRow = col / (uniforms.filterDims[1] * uniforms.outBackprop[3]);
      let WCol = col / uniforms.outBackprop[3] % uniforms.filterDims[1];
      let xR = f32(outRow - uniforms.pads[0] + WRow) / f32(uniforms.stride[0]);
      let xC = f32(outCol - uniforms.pads[1] + WCol) / f32(uniforms.stride[1]);
      if (xR < 0.0 || xR >= f32(uniforms.outBackprop[1]) || fract(xR) > 0.0) {
        return ${typeSnippet(innerElementSize)}(0.0);
      }
      if (xC < 0.0 || xC >= f32(uniforms.outBackprop[2]) || fract(xC) > 0.0) {
        return ${typeSnippet(innerElementSize)}(0.0);
      }
      let coord = vec4<i32>(
          batch,
          i32(xR),
          i32(xC),
          col % uniforms.outBackprop[3]);
      return x[getIndexFromCoords4D(coord, uniforms.xShape)/${
      innerElementSize}];`;

  const sampleA = `if (row < uniforms.dimAOuter && col < uniforms.dimInner) {
        ${readASnippet}
      }
      return ${typeSnippet(innerElementSize)}(0.0);`;

  const userCode = `
  fn mm_readA(row : i32, colIn : i32, globalId : vec3<u32>) -> ${
      typeSnippet(innerElementSize)} {
    let col = colIn * ${innerElementSize};
    var batch = i32(globalId.z);
    ${sampleA}
  }

  fn mm_readB(row : i32, colIn : i32, globalId : vec3<u32>) -> ${
      typeSnippet(innerElementSize)} {
    let col = colIn * ${innerElementSize};
    let coordX = uniforms.filterDims.x - 1 -
        row / (uniforms.filterDims[1] * uniforms.outBackprop[3]);
    let coordY = uniforms.filterDims.y - 1 -
        (row / uniforms.outBackprop[3]) % uniforms.filterDims[1];
    if (row < uniforms.dimInner && col < uniforms.dimBOuter &&
        coordX >= 0 && coordY >= 0) {
      let rowInner = row % uniforms.outBackprop[3];
      let coord = vec4<i32>(coordX, coordY, col, rowInner);
      ${getWSnippet(innerElementSize)}
    }
    return ${typeSnippet(innerElementSize)}(0.0);
  }

  fn mm_write(row : i32, colIn : i32, valueInput : ${
      typeSnippet(innerElementSize)}, globalId : vec3<u32>) {
    let col = colIn * ${innerElementSize};
    if (row < uniforms.dimAOuter && (col + ${
      innerElementSize - 1}) < uniforms.dimBOuter) {
      var batch = i32(globalId.z);
      var value = valueInput;
      let outCoord = vec4<i32>(
          batch,
          row / uniforms.outShape[2],
          row % uniforms.outShape[2],
          col);
      result[getIndexFromCoords4D(outCoord, uniforms.outShape)/${
      innerElementSize}] = value;
    }
  }`;
  return userCode;
}

export class Conv2DDerInputMMProgram implements WebGPUProgram {
  outputShape: number[];
  shaderKey: string;
  dispatchLayout: {x: number[], y: number[], z: number[]};
  dispatch: [number, number, number];
  variableNames = ['x', 'W'];
  variableTypes: string[];
  uniforms =
      'filterDims : vec2<i32>, pads : vec2<i32>, stride : vec2<i32>, outBackprop : vec4<i32>, dimAOuter : i32, dimBOuter : i32, dimInner : i32,';
  workGroupSize: [number, number, number];
  elementsPerThread: [number, number, number];
  tileAOuter: number;
  tileBOuter: number;
  tileInner: number;
  innerElementSize: number;
  isVec4?: boolean;

  constructor(convInfo: backend_util.Conv2DInfo) {
    this.outputShape = convInfo.inShape;

    util.assert(
        convInfo.dataFormat === 'channelsLast',
        () => 'TODO: NCHW is unimplemented');
    this.isVec4 =
        convInfo.inChannels % 4 === 0 && convInfo.outChannels % 4 === 0;
    this.dispatchLayout = {x: [3], y: [1, 2], z: [0]};
    this.workGroupSize = computeWorkGroupSizeForConv2d(
        this.dispatchLayout, this.outputShape, this.isVec4);
    this.elementsPerThread = computeWorkPerThreadForConv2d(
        this.dispatchLayout, this.outputShape, this.isVec4);

    this.dispatch = computeDispatch(
        this.dispatchLayout, this.outputShape, this.workGroupSize,
        this.elementsPerThread);

    if (this.isVec4) {
      this.innerElementSize = 4;
      this.variableTypes = ['vec4<f32>', 'f32'];
    } else {
      this.innerElementSize = this.elementsPerThread[0];
    }
    this.tileAOuter = this.workGroupSize[1] * this.elementsPerThread[1];
    this.tileBOuter = this.workGroupSize[0] * this.elementsPerThread[0];
    this.tileInner = Math.max(
        this.workGroupSize[0] * this.innerElementSize, this.workGroupSize[1]);
    this.shaderKey = `conv2DDerInputMM_${this.isVec4}_${
        this.elementsPerThread}_${this.innerElementSize}`;
  }

  getUserCode(): string {
    const matMulSource = this.isVec4 ?
        makeMatMulPackedVec4Source(
            this.elementsPerThread, this.tileAOuter, this.tileBOuter,
            this.tileInner, this.innerElementSize) :
        makeMatMulPackedSource(this.elementsPerThread, this.workGroupSize);
    const userCode = `
    ${conv2dTransposeCommonSnippet(this.isVec4 ? 4 : 1)}
    ${matMulSource}
    `;
    return userCode;
  }
}
