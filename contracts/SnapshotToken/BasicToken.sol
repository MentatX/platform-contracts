pragma solidity 0.4.26;


import "../Standards/IBasicToken.sol";
import "../Math.sol";
import "./Helpers/MTokenTransferController.sol";
import "./Helpers/MTokenTransfer.sol";


/**
 * @title Basic token
 * @dev Basic version of StandardToken, with no allowances.
 */
contract BasicToken is
    MTokenTransfer,
    MTokenTransferController,
    IBasicToken
{

    ////////////////////////
    // Mutable state
    ////////////////////////

    mapping(address => uint256) internal _balances;

    uint256 internal _totalSupply;

    ////////////////////////
    // Public functions
    ////////////////////////

    /**
    * @dev transfer token for a specified address
    * @param to The address to transfer to.
    * @param amount The amount to be transferred.
    */
    function transfer(address to, uint256 amount)
        public
        returns (bool)
    {
        mTransfer(msg.sender, to, amount);
        return true;
    }

    /// @dev This function makes it easy to get the total number of tokens
    /// @return The total number of tokens
    function totalSupply()
        public
        constant
        returns (uint256)
    {
        return _totalSupply;
    }

    /**
    * @dev Gets the balance of the specified address.
    * @param owner The address to query the the balance of.
    * @return An uint256 representing the amount owned by the passed address.
    */
    function balanceOf(address owner)
        public
        constant
        returns (uint256 balance)
    {
        return _balances[owner];
    }

    ////////////////////////
    // Internal functions
    ////////////////////////

    //
    // Implements MTokenTransfer
    //

    function mTransfer(address from, address to, uint256 amount)
        internal
    {
        require(to != address(0));
        require(mOnTransfer(from, to, amount));

        _balances[from] = Math.sub(_balances[from], amount);
        _balances[to] = Math.add(_balances[to], amount);
        emit Transfer(from, to, amount);
    }
}
