// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 6307229538032982905608864297883620610281819927650339829831215746705974586222;
    uint256 constant alphay  = 1497066583376471128636179618062927934775016384952346654888502916993828140389;
    uint256 constant betax1  = 17859208452101796246914264130708293772454805290704143604110716832414120904268;
    uint256 constant betax2  = 323430713145053335227595275257955329696075721685207934031626567713180858391;
    uint256 constant betay1  = 12252538687011669462744442965226866323391939091162398344325267935982663587461;
    uint256 constant betay2  = 4531851543617782817226943651777839159048875699331155323596529454981892518648;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;

    
    uint256 constant IC0x = 6753836407300714158919966478386621402168818369217167865727284047202529032933;
    uint256 constant IC0y = 606256450190990264604528491091896681526813397662587719778483226616918886412;
    
    uint256 constant IC1x = 7672067152781542812381437041206725582228380938595835913891999734461076749565;
    uint256 constant IC1y = 10665771300926910357626416765254221222283774511002307445548194361268063463046;
    
    uint256 constant IC2x = 3860030650289412114849652468744177022285795491927386584121225256617837356432;
    uint256 constant IC2y = 1105027577892556454052292216133591601933247100535559814191160436925929945708;
    
    uint256 constant IC3x = 15272556040788592567282236805095567216246004874830917983676772905954017066494;
    uint256 constant IC3y = 19029045602940632140194934559230626537467022901155654162936425197372690775159;
    
    uint256 constant IC4x = 17033739446708220572986566883979114770132565047484743526591937759665743569022;
    uint256 constant IC4y = 16655042912014806956833313833619552327734062078892871678123963154018606821018;
    
    uint256 constant IC5x = 2013125782062040861043688344185542118844506220169213847125579635987396639266;
    uint256 constant IC5y = 12386539575577741598357787770833943118071927239029359924584933873459265249069;
    
    uint256 constant IC6x = 13011935249538683984529817373024785687604637404777499790528929785557480424635;
    uint256 constant IC6y = 11868065522339332965528192094731532413549120126632407061580215785522366728420;
    
    uint256 constant IC7x = 12078664173634524162588966070099209951617600732103813517793411219881574522861;
    uint256 constant IC7y = 2633856048361349739125876531138444492178865737833138778125770215182295130999;
    
    uint256 constant IC8x = 15619579935968197117186872964297968055651976952554161320881704471352930086317;
    uint256 constant IC8y = 12560062463223510803318537857472954909651850445290503597900405923524671940002;
    
    uint256 constant IC9x = 1667860250603311928219439066040937795594808519422419252357156539891693182345;
    uint256 constant IC9y = 21748536034931677677520710489879038568842859539922823393819463889637572887330;
    
    uint256 constant IC10x = 17333922192318576564021045626135681936828805982620112182929910943265088347512;
    uint256 constant IC10y = 9340055726763699459008398572950292806205174896771844703716990873373088558561;
    
    uint256 constant IC11x = 9917664103661211223600389979101063609686827940223965442320501315769206473203;
    uint256 constant IC11y = 20399623476318314403289788306800262110508715117474441038347013554217230342772;
    
    uint256 constant IC12x = 21446947333282996253671445740432138575176961518067836031884981013929958546307;
    uint256 constant IC12y = 6749288297494915409389624830279093490965763439553411024413782824279666844560;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[12] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
